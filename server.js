import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CENTRE_CODE = process.env.CENTRE_CODE || 'LOGPOM_ANDEM';
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error('Configuration manquante : définissez SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY dans .env.');
  process.exit(1);
}
const makeAnonClient = () => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const serviceClient = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const roleToUi = { administrateur: 'admin', officier: 'officer', agent: 'agent', citoyen: 'citizen', auditeur: 'auditor' };
const uiToRole = { admin: 'administrateur', officer: 'officier', agent: 'agent', citizen: 'citoyen', auditor: 'auditeur' };
const roleLabel = { admin: 'Administrateur système', officer: "Officier d'état civil", agent: "Agent d'état civil", citizen: 'Citoyen', auditor: 'Auditeur' };
const statusToUi = { brouillon: 'Brouillon', en_verification: 'En attente', valide: 'Validé', rejete: 'Rejeté', archive: 'Archivé' };
const statusToDb = { 'Brouillon': 'brouillon', 'En attente': 'en_verification', 'Validé': 'valide', 'Rejeté': 'rejete', 'Archivé': 'archive' };
const requestStatuses = ['Reçue', 'En traitement', 'Validée', 'Prête', 'Rejetée'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const clean = value => String(value ?? '').trim();
const now = () => new Date().toISOString();
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body === null ? '' : JSON.stringify(body));
};
const safeJson = async req => new Promise((resolve, reject) => {
  let raw = ''; let length = 0;
  req.on('data', chunk => { length += chunk.length; if (length > 1_000_000) reject(new HttpError(413, 'Requête trop volumineuse.')); else raw += chunk; });
  req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'JSON invalide.')); } });
  req.on('error', () => reject(new HttpError(400, 'Requête invalide.')));
});
const makeUserClient = token => createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${token}` } }
});
function bearer(req) { return req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''; }
async function currentUser(req) {
  const token = bearer(req);
  if (!token) return null;
  const client = makeUserClient(token);
  const { data: authData, error: authError } = await client.auth.getUser(token);
  if (authError || !authData?.user) return null;
  const { data: profile, error } = await client.from('profiles')
    .select('id,centre_id,role,nom_complet,actif,is_primary_admin')
    .eq('id', authData.user.id).maybeSingle();
  if (error || !profile || !profile.actif || !profile.centre_id) return null;
  return {
    id: profile.id, centreId: profile.centre_id, email: authData.user.email,
    name: profile.nom_complet || authData.user.user_metadata?.full_name || authData.user.email,
    role: roleToUi[profile.role] || 'agent', isPrimaryAdmin: Boolean(profile.is_primary_admin),
    roleLabel: profile.is_primary_admin ? 'Administrateur principal' : (roleLabel[roleToUi[profile.role]] || profile.role),
    client, authUser: authData.user
  };
}
async function requireAuth(req) { const user = await currentUser(req); if (!user) fail(401, 'Connexion requise ou session expirée.'); return user; }
async function requireRoles(req, roles) { const user = await requireAuth(req); if (!roles.includes(user.role)) fail(403, 'Vous ne disposez pas des droits nécessaires.'); return user; }
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, roleLabel: user.roleLabel, isPrimaryAdmin: Boolean(user.isPrimaryAdmin) }; }
async function getCentre(client, centreId) {
  const { data, error } = await client.from('centres_etat_civil').select('id,code,nom,arrondissement,adresse,telephone').eq('id', centreId).maybeSingle();
  if (error) throw new HttpError(500, 'Impossible de charger le centre associé au compte.');
  return data;
}
function mapAct(row) {
  return { id: row.id, ref: row.reference, type: ({ naissance: 'Naissance', mariage: 'Mariage', deces: 'Décès' })[row.type] || row.type,
    person: row.personne_concernee || 'Non renseigné', eventDate: row.date_evenement, place: row.lieu_evenement || '',
    centre: row.centres_etat_civil?.nom || row.centre_nom || 'Centre associé', status: statusToUi[row.statut] || row.statut,
    notes: row.notes || '', createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapRequest(row) { return { id: row.id, ref: row.reference, name: row.nom_demandeur, email: row.email_demandeur, document: row.document_demande, act: row.reference_acte, reason: row.motif, status: row.statut, createdAt: row.created_at, updatedAt: row.updated_at }; }
async function listActs(user) {
  const { data, error } = await user.client.from('actes').select('id,reference,type,statut,date_evenement,personne_concernee,lieu_evenement,notes,created_at,updated_at,centres_etat_civil(nom)').eq('centre_id', user.centreId).order('created_at', { ascending: false }).limit(500);
  if (error) throw new HttpError(500, `Lecture des actes impossible : ${error.message}`);
  return (data || []).map(mapAct);
}
async function listRequests(user) {
  let query = user.client.from('demandes_citoyennes').select('id,reference,nom_demandeur,email_demandeur,document_demande,reference_acte,motif,statut,created_at,updated_at').eq('centre_id', user.centreId).order('created_at', { ascending: false }).limit(500);
  if (user.role === 'citizen') query = query.eq('user_id', user.id);
  const { data, error } = await query;
  if (error) throw new HttpError(500, `Lecture des demandes impossible : ${error.message}`);
  return (data || []).map(mapRequest);
}
async function listMentions(user) {
  const { data, error } = await user.client.from('mentions_marginales').select('id,reference_acte,type,source_reference,notes,created_at,profiles(nom_complet)').eq('centre_id', user.centreId).order('created_at', { ascending: false }).limit(300);
  if (error) throw new HttpError(500, `Lecture des mentions impossible : ${error.message}`);
  return (data || []).map(row => ({ id: row.id, act: row.reference_acte, type: row.type, source: row.source_reference, notes: row.notes, author: row.profiles?.nom_complet || 'Utilisateur autorisé', createdAt: row.created_at }));
}
async function statsFor(user, acts, requests) {
  return { actsTotal: acts.length, pendingActs: acts.filter(a => a.status !== 'Validé').length, validatedActs: acts.filter(a => a.status === 'Validé').length,
    requestsTotal: requests.length, receivedRequests: requests.filter(r => r.status === 'Reçue').length,
    birthCount: acts.filter(a => a.type === 'Naissance').length, marriageCount: acts.filter(a => a.type === 'Mariage').length, deathCount: acts.filter(a => a.type === 'Décès').length };
}
async function auditInsert(user, action, entity, reference, details = '') {
  if (!serviceClient) return;
  await serviceClient.from('journal_application').insert({ centre_id: user.centreId, acteur_id: user.id, action, entite: entity, reference_entite: String(reference || ''), details }).then(() => {});
}
function reference(prefix) { return `${prefix}-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`; }

async function api(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { status: 'ok', database: 'supabase' });
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await safeJson(req); const email = clean(body.email).toLowerCase(); const password = String(body.password || '');
    if (!email || !password) fail(422, 'Adresse e-mail et mot de passe requis.');
    const { data, error } = await makeAnonClient().auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) fail(401, 'Identifiants incorrects ou e-mail non confirmé.');
    const user = await currentUser({ headers: { authorization: `Bearer ${data.session.access_token}` } });
    if (!user) fail(403, 'Compte créé mais aucun profil actif n’est associé à un centre. Contactez l’administrateur principal.');
    return json(res, 200, { token: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at, user: publicUser(user) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/refresh') {
    const body = await safeJson(req); const refreshToken = String(body.refreshToken || '');
    if (!refreshToken) fail(422, 'Jeton de renouvellement manquant.');
    const { data, error } = await makeAnonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) fail(401, 'Session expirée. Veuillez vous reconnecter.');
    const user = await currentUser({ headers: { authorization: `Bearer ${data.session.access_token}` } });
    if (!user) fail(403, 'Aucun profil actif associé à ce compte.');
    return json(res, 200, { token: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at, user: publicUser(user) });
  }
  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const user = await currentUser(req);
    if (user) { const token = bearer(req); await user.client.auth.signOut({ scope: 'local' }); }
    return json(res, 204, null);
  }
  if (req.method === 'GET' && pathname === '/api/auth/me') return json(res, 200, { user: publicUser(await requireAuth(req)) });
  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const user = await requireAuth(req); const centre = await getCentre(user.client, user.centreId);
    if (user.role === 'citizen') return json(res, 200, { user: publicUser(user), centre, requests: await listRequests(user), acts: [], mentions: [], stats: {} });
    const acts = await listActs(user); const requests = await listRequests(user); const mentions = await listMentions(user);
    let audit = [];
    if (user.role === 'admin') {
      const { data } = await user.client.from('journal_application').select('action,reference_entite,created_at,profiles(nom_complet)').eq('centre_id', user.centreId).order('created_at', { ascending: false }).limit(5);
      audit = (data || []).map(row => ({ action: row.action, entityRef: row.reference_entite, createdAt: row.created_at, name: row.profiles?.nom_complet || 'Utilisateur' }));
    }
    return json(res, 200, { user: publicUser(user), centre, acts, requests, mentions, stats: await statsFor(user, acts, requests), audit });
  }
  if (req.method === 'GET' && pathname === '/api/acts') { const user = await requireRoles(req, ['agent','officer','admin','auditor']); return json(res, 200, { acts: await listActs(user) }); }
  if (req.method === 'POST' && pathname === '/api/acts') {
    const user = await requireRoles(req, ['agent','officer','admin']); const body = await safeJson(req);
    const typeMap = { Naissance: 'naissance', Mariage: 'mariage', 'Décès': 'deces' };
    const type = typeMap[clean(body.type)]; const person = clean(body.person); const eventDate = clean(body.eventDate); const place = clean(body.place);
    if (!type || !person || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !place) fail(422, 'Veuillez renseigner les champs obligatoires avec des valeurs valides.');
    const prefix = type === 'naissance' ? 'NAI' : type === 'mariage' ? 'MAR' : 'DEC';
    const { data, error } = await user.client.from('actes').insert({ centre_id: user.centreId, type, reference: reference(prefix), statut: 'en_verification', date_evenement: eventDate, personne_concernee: person.slice(0, 150), lieu_evenement: place.slice(0, 150), notes: clean(body.notes).slice(0, 1500), cree_par: user.id }).select('id,reference,type,statut,date_evenement,personne_concernee,lieu_evenement,notes,created_at,updated_at,centres_etat_civil(nom)').single();
    if (error) throw new HttpError(400, `Enregistrement impossible : ${error.message}`);
    await auditInsert(user, 'CREATION', 'acte', data.reference, `Création d’un acte de ${body.type}`);
    return json(res, 201, { act: mapAct(data) });
  }
  const validateMatch = pathname.match(/^\/api\/acts\/([^/]+)\/validate$/);
  if (req.method === 'POST' && validateMatch) {
    const user = await requireRoles(req, ['officer','admin']); const id = validateMatch[1];
    const { data, error } = await user.client.from('actes').update({ statut: 'valide', valide_par: user.id, date_validation: now() }).eq('id', id).eq('centre_id', user.centreId).select('id,reference,type,statut,date_evenement,personne_concernee,lieu_evenement,notes,created_at,updated_at,centres_etat_civil(nom)').maybeSingle();
    if (error) throw new HttpError(400, `Validation impossible : ${error.message}`); if (!data) fail(404, 'Acte introuvable ou accès refusé.');
    await auditInsert(user, 'VALIDATION', 'acte', data.reference, 'Acte validé'); return json(res, 200, { act: mapAct(data) });
  }
  if (req.method === 'GET' && pathname === '/api/requests') return json(res, 200, { requests: await listRequests(await requireAuth(req)) });
  if (req.method === 'POST' && pathname === '/api/requests') {
    const user = await requireAuth(req); const body = await safeJson(req); const document = clean(body.document); const act = clean(body.act).toUpperCase();
    const name = clean(body.name) || user.name; const email = clean(body.email).toLowerCase() || user.email;
    if (!['Extrait de naissance','Copie intégrale','Extrait de mariage','Extrait de décès'].includes(document) || !act || !name || !email.includes('@')) fail(422, 'Veuillez compléter correctement votre demande.');
    const { data, error } = await user.client.from('demandes_citoyennes').insert({ centre_id: user.centreId, user_id: user.id, reference: reference('DEM'), nom_demandeur: name.slice(0,150), email_demandeur: email.slice(0,150), document_demande: document, reference_acte: act.slice(0,80), motif: clean(body.reason).slice(0,1000), statut: 'Reçue' }).select('*').single();
    if (error) throw new HttpError(400, `Création de la demande impossible : ${error.message}`);
    await auditInsert(user, 'CREATION', 'demande', data.reference, 'Demande citoyenne créée'); return json(res, 201, { request: mapRequest(data) });
  }
  const progressMatch = pathname.match(/^\/api\/requests\/([^/]+)\/progress$/);
  if (req.method === 'POST' && progressMatch) {
    const user = await requireRoles(req, ['agent','officer','admin']); const body = await safeJson(req); const id = progressMatch[1];
    const { data: existing, error: readError } = await user.client.from('demandes_citoyennes').select('*').eq('id', id).eq('centre_id', user.centreId).maybeSingle();
    if (readError) throw new HttpError(400, readError.message); if (!existing) fail(404, 'Demande introuvable.');
    const next = clean(body.status) || ({ 'Reçue': 'En traitement', 'En traitement': 'Prête' })[existing.statut];
    if (!requestStatuses.includes(next)) fail(422, 'Statut de demande invalide.');
    const { data, error } = await user.client.from('demandes_citoyennes').update({ statut: next, updated_at: now() }).eq('id', id).eq('centre_id', user.centreId).select('*').single();
    if (error) throw new HttpError(400, `Mise à jour impossible : ${error.message}`);
    await auditInsert(user, 'MISE_A_JOUR', 'demande', data.reference, `Demande passée au statut ${next}`); return json(res, 200, { request: mapRequest(data) });
  }
  if (req.method === 'GET' && pathname === '/api/mentions') return json(res, 200, { mentions: await listMentions(await requireRoles(req, ['agent','officer','admin','auditor'])) });
  if (req.method === 'POST' && pathname === '/api/mentions') {
    const user = await requireRoles(req, ['agent','officer','admin']); const body = await safeJson(req); const act = clean(body.act).toUpperCase(); const type = clean(body.type); const source = clean(body.source);
    if (!act || !source || !['Divorce','Reconnaissance','Rectification','Séparation de corps'].includes(type)) fail(422, 'Les informations de la mention sont invalides.');
    const { data, error } = await user.client.from('mentions_marginales').insert({ centre_id: user.centreId, reference_acte: act.slice(0,80), type, source_reference: source.slice(0,200), notes: clean(body.notes).slice(0,1500), auteur_id: user.id }).select('id,reference_acte,type,source_reference,notes,created_at,profiles(nom_complet)').single();
    if (error) throw new HttpError(400, `Ajout de la mention impossible : ${error.message}`);
    await auditInsert(user, 'CREATION', 'mention', act, `Mention ${type.toLowerCase()} ajoutée`); return json(res, 201, { mention: { id: data.id, act: data.reference_acte, type: data.type, source: data.source_reference, notes: data.notes, author: data.profiles?.nom_complet || user.name, createdAt: data.created_at } });
  }
  if (req.method === 'POST' && pathname === '/api/users') {
    const administrator = await requireRoles(req, ['admin']); if (!administrator.isPrimaryAdmin && !serviceClient) fail(403, 'Seul l’administrateur principal peut créer des comptes tant que le serveur n’est pas configuré pour l’administration sécurisée.');
    if (!serviceClient) fail(503, 'La création des comptes nécessite SUPABASE_SERVICE_ROLE_KEY configurée uniquement côté serveur. Ne la mettez jamais dans le navigateur.');
    const body = await safeJson(req); const name = clean(body.name); const email = clean(body.email).toLowerCase(); const role = clean(body.role); const dbRole = uiToRole[role];
    if (!name || !email.includes('@') || !['agent','officer','admin','auditor','citizen'].includes(role)) fail(422, 'Nom, e-mail et rôle valide requis.');
    if (role === 'admin' && !administrator.isPrimaryAdmin) fail(403, 'Seul l’administrateur principal peut créer un autre administrateur.');
    const { data: created, error: createError } = await serviceClient.auth.admin.inviteUserByEmail(email, { data: { full_name: name } });
    if (createError || !created?.user) fail(400, createError?.message || 'Invitation impossible. Vérifiez la configuration e-mail Supabase.');
    const { error: profileError } = await serviceClient.from('profiles').insert({ id: created.user.id, centre_id: administrator.centreId, role: dbRole, nom_complet: name, actif: true, is_primary_admin: false });
    if (profileError) { await serviceClient.auth.admin.deleteUser(created.user.id); fail(400, `Le profil n’a pas pu être créé : ${profileError.message}`); }
    await auditInsert(administrator, 'CREATION', 'utilisateur', email, `Invitation envoyée pour le rôle ${role}`);
    return json(res, 201, { user: { id: created.user.id, name, email, role, roleLabel: roleLabel[role] }, message: 'Invitation envoyée par e-mail. Le nouvel utilisateur devra définir son mot de passe.' });
  }
  if (req.method === 'GET' && pathname === '/api/statistics') { const user = await requireRoles(req, ['officer','admin']); const acts = await listActs(user); const requests = await listRequests(user); return json(res, 200, { stats: await statsFor(user, acts, requests) }); }
  if (req.method === 'GET' && pathname === '/api/audit') {
    const user = await requireRoles(req, ['admin']); const { data, error } = await user.client.from('journal_application').select('action,entite,reference_entite,details,created_at,profiles(nom_complet)').eq('centre_id', user.centreId).order('created_at', { ascending: false }).limit(100);
    if (error) throw new HttpError(400, error.message); return json(res, 200, { audit: (data || []).map(row => ({ action: row.action, entityType: row.entite, entityRef: row.reference_entite, details: row.details, createdAt: row.created_at, name: row.profiles?.nom_complet || 'Utilisateur' })) });
  }
  if (req.method === 'GET' && pathname.startsWith('/api/verify/')) {
    const code = decodeURIComponent(pathname.split('/').pop()).toUpperCase(); const { data, error } = await makeAnonClient().rpc('verifier_acte_public', { p_reference: code });
    const row = data?.[0];
    if (error || !row) return json(res, 404, { valid: false, message: 'Aucun document validé correspondant à ce numéro.' });
    return json(res, 200, { valid: true, document: { number: row.reference, type: `Acte de ${row.type}`, eventDate: row.date_evenement, centre: row.centre_nom } });
  }
  fail(404, 'Route API introuvable.');
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
async function staticFile(res, pathname) {
  let decoded; try { decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch { return json(res, 400, { error: 'Chemin invalide.' }); }
  const relative = normalize(decoded).replace(/^([\\/])+/, '');
  if (relative.startsWith('..') || relative.startsWith('data') || relative.startsWith('.env')) return json(res, 403, { error: 'Accès refusé.' });
  const file = join(ROOT, relative);
  if (!file.startsWith(ROOT) || !existsSync(file)) return json(res, 404, { error: 'Fichier introuvable.' });
  const buffer = await readFile(file); res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" }); res.end(buffer);
}
export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    if (!['GET','HEAD'].includes(req.method || 'GET')) return json(res, 405, { error: 'Méthode non autorisée.' });
    if (req.method === 'HEAD') return res.writeHead(200).end();
    return await staticFile(res, url.pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    return json(res, status, { error: error.message || 'Une erreur inattendue est survenue.' });
  }
}
const server = createServer(handleRequest);
if (!process.env.VERCEL) server.listen(PORT, () => console.log(`ÉtatCivil connecté à Supabase sur http://localhost:${PORT}`));
