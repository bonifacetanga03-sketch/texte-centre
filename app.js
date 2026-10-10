(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escape = (value = '') => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
  const icon = name => `<svg><use href="#${name}"/></svg>`;
  const tokenKey = 'etatcivil.api.token';
  const refreshKey = 'etatcivil.api.refresh';
  const state = { token: localStorage.getItem(tokenKey), refreshToken: localStorage.getItem(refreshKey), user: null, centre: null, acts: [], requests: [], mentions: [], stats: {}, audit: [] };
  const roleName = { citizen: 'Citoyen', agent: "Agent d'état civil", officer: "Officier d'état civil", admin: 'Administrateur système', auditor: 'Auditeur' };
  const typeClass = type => type === 'Naissance' ? 'birth' : type === 'Mariage' ? 'marriage' : 'death';
  const actIcon = type => type === 'Mariage' ? 'i-users' : type === 'Décès' ? 'i-shield' : 'i-file';
  const statusClass = status => ['Validé', 'Prête'].includes(status) ? 'valid' : ['En attente', 'Reçue', 'En traitement'].includes(status) ? 'pending' : 'draft';
  const statusBadge = status => `<span class="status ${statusClass(status)}">${escape(status)}</span>`;
  const shortDate = value => {
    if (!value) return '—';
    const date = new Date(value.includes('T') ? value : `${value}T12:00:00`);
    return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  };
  const relative = value => {
    if (!value) return '—'; const difference = Math.max(0, Date.now() - new Date(value).valueOf()); const minutes = Math.floor(difference / 60000);
    if (minutes < 2) return 'À l’instant'; if (minutes < 60) return `Il y a ${minutes} min`; if (minutes < 1440) return `Il y a ${Math.floor(minutes / 60)} h`; return shortDate(value);
  };
  const initials = value => String(value).trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
  const currentRole = () => state.user?.role || 'agent';
  const internal = () => ['agent', 'officer', 'admin'].includes(currentRole());
  const canValidate = () => ['officer', 'admin'].includes(currentRole());

  async function request(path, options = {}) {
    const send = () => fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(options.headers || {}) } });
    let response = await send();
    if (response.status === 401 && state.refreshToken && path !== '/auth/refresh' && path !== '/auth/login') {
      const refreshed = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: state.refreshToken }) });
      const refreshBody = await refreshed.json().catch(() => ({}));
      if (refreshed.ok && refreshBody.token) { state.token = refreshBody.token; state.refreshToken = refreshBody.refreshToken; localStorage.setItem(tokenKey, state.token); localStorage.setItem(refreshKey, state.refreshToken); response = await send(); }
      else { state.token = null; state.refreshToken = null; localStorage.removeItem(tokenKey); localStorage.removeItem(refreshKey); }
    }
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Une erreur est survenue.');
    return body;
  }
  const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

  function updateIdentity() {
    const user = state.user || { name: 'Utilisateur', role: 'agent', roleLabel: roleName.agent };
    $('#agent-name').textContent = user.name;
    const greeting = $('#dashboard-greeting-name'); if (greeting) greeting.textContent = user.name.split(/\s+/)[0];
    const today = $('#today-label'); if (today) today.textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    $('#agent-role').textContent = user.roleLabel || roleName[user.role];
    $('#agent-initials').textContent = initials(user.name);
    $('#session-role').textContent = user.roleLabel || roleName[user.role];
    $('#citizen-switch').classList.toggle('hidden', user.role === 'citizen');
    const centreName = state.centre?.nom || 'Centre d’état civil';
    const centreLabel = $('#centre-active-name'); if (centreLabel) centreLabel.textContent = centreName;
    const loginCentre = $('#login-centre-name'); if (loginCentre) loginCentre.textContent = centreName.toUpperCase();
  }
  function renderActs() {
    const search = ($('#registry-search')?.value || '').trim().toLowerCase(); const type = $('#registry-type')?.value || 'all'; const status = $('#registry-status')?.value || 'all';
    const acts = state.acts.filter(act => (type === 'all' || act.type === type) && (status === 'all' || act.status === status) && (!search || `${act.ref} ${act.person} ${act.place} ${act.centre}`.toLowerCase().includes(search)));
    const renderRow = act => `<tr><td><b>${escape(act.ref)}</b></td><td><span class="tiny-type ${typeClass(act.type)}">${icon(actIcon(act.type))}</span> ${escape(act.type)}</td><td><b>${escape(act.person)}</b></td><td>${shortDate(act.eventDate)} · ${escape(act.place)}</td><td>${escape(act.centre)}</td><td>${statusBadge(act.status)}</td><td>${act.status !== 'Validé' && canValidate() ? `<button class="text-button act-validate" data-id="${act.id}">Valider</button>` : '<button class="row-action" aria-label="Options">•••</button>'}</td></tr>`;
    $('#registry-body').innerHTML = acts.map(renderRow).join('') || '<tr><td colspan="7" class="empty-row">Aucun acte ne correspond à votre recherche.</td></tr>';
    $('#registry-count').textContent = `${acts.length} acte${acts.length > 1 ? 's' : ''} affiché${acts.length > 1 ? 's' : ''}`;
    $('#recent-acts').innerHTML = state.acts.slice(0, 4).map(act => `<tr><td><span class="type-cell"><span class="tiny-type ${typeClass(act.type)}">${icon(actIcon(act.type))}</span>${escape(act.type)}</span></td><td><b>${escape(act.ref)}</b></td><td>${escape(act.person)}</td><td>${shortDate(act.createdAt || act.eventDate)}</td><td>${statusBadge(act.status)}</td><td><button class="row-action" aria-label="Options">•••</button></td></tr>`).join('');
    const st = { ...state.stats, actsTotal: state.acts.length, pendingActs: state.acts.filter(act => act.status !== 'Validé').length, validatedActs: state.acts.filter(act => act.status === 'Validé').length };
    $('#stat-acts').textContent = st.actsTotal || 0; $('#stat-waiting').textContent = st.pendingActs || 0;
    const validated = state.acts.filter(act => act.status === 'Validé').length; const validatedNode = $('#stat-validated'); if (validatedNode) validatedNode.textContent = validated;
    const birth = $('#report-birth-count'); if (birth) birth.textContent = state.acts.filter(act => act.type === 'Naissance').length;
    const marriage = $('#report-marriage-count'); if (marriage) marriage.textContent = state.acts.filter(act => act.type === 'Mariage').length;
    const death = $('#report-death-count'); if (death) death.textContent = state.acts.filter(act => act.type === 'Décès').length;
  }
  function renderRequests() {
    const search = ($('#request-search')?.value || '').trim().toLowerCase(); const type = $('#request-type')?.value || 'all'; const filter = document.querySelector('.summary-tile.selected')?.dataset.requestFilter || 'all';
    const requests = state.requests.filter(req => (filter === 'all' || req.status === filter) && (type === 'all' || req.document === type) && (!search || `${req.name} ${req.ref} ${req.document}`.toLowerCase().includes(search)));
    $('#request-list').innerHTML = requests.map(req => `<article class="request-item"><div class="request-avatar">${escape(initials(req.name))}</div><div><h3>${escape(req.name)}</h3><p>${escape(req.ref)} · ${escape(req.email)}</p></div><div class="request-detail"><b>${escape(req.document)}</b>Acte concerné : ${escape(req.act)}</div><div><p class="request-detail">Reçue ${relative(req.createdAt)}</p>${statusBadge(req.status)}</div><button class="text-button request-detail-button" data-id="${req.id}">${internal() ? 'Traiter' : 'Consulter'} ${icon('i-chevron')}</button></article>`).join('') || '<p class="empty-row">Aucune demande ne correspond à ces critères.</p>';
    const received = state.requests.filter(req => req.status === 'Reçue').length; $('#stat-requests').textContent = state.requests.length; $('#all-requests-number').textContent = state.requests.length; $('#received-number').textContent = received; $('#request-badge').textContent = received;
    $('#urgent-list').innerHTML = state.requests.filter(req => req.status === 'Reçue').slice(0, 3).map(req => `<div class="urgent-item"><span class="urgent-icon ${req.document.includes('naissance') ? 'teal-bg' : ''}">${icon(req.document.includes('naissance') ? 'i-file' : 'i-users')}</span><div><h3>${escape(req.document)} à instruire</h3><p>${escape(req.name)} · ${escape(req.ref)}</p></div><button class="request-detail-button" data-id="${req.id}">Traiter</button></div>`).join('') || `<div class="urgent-item"><span class="urgent-icon teal-bg">${icon('i-check')}</span><div><h3>Tout est à jour</h3><p>Aucune demande à instruire pour le moment.</p></div></div>`;
  }
  function renderMentions() { $('#mentions-body').innerHTML = state.mentions.map(item => `<tr><td><b>${escape(item.act)}</b></td><td>${escape(item.type)}</td><td>${escape(item.source)}</td><td>${escape(item.author)}</td><td>${shortDate(item.createdAt)}</td><td><button class="row-action" aria-label="Options">•••</button></td></tr>`).join(''); }
  function renderAll() { updateIdentity(); renderActs(); renderRequests(); renderMentions(); }

  function switchView(view) {
    $$('.view').forEach(item => item.classList.toggle('active', item.id === `${view}-view`)); $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    const labels = { dashboard: 'Tableau de bord', registry: 'Registre des actes', requests: 'Demandes citoyennes', mentions: 'Mentions marginales', statistics: 'Statistiques', admin: 'Administration' }; $('#breadcrumb').innerHTML = `Espace interne <span>/</span> ${labels[view]}`; $('#sidebar').classList.remove('open'); window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  let toastTimer;
  function showToast(message, isError = false) { const node = $('#toast'); $('#toast-message').textContent = message; node.classList.remove('hidden'); node.style.background = isError ? '#9d4248' : '#263b45'; clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.add('hidden'), 3500); }
  function showLogin(error = '') { $('#app').classList.add('hidden'); $('#citizen-portal').classList.add('hidden'); $('#login-screen').classList.remove('hidden'); const note = $('#login-error'); note.textContent = error; note.classList.toggle('hidden', !error); }
  function showInternal() { $('#login-screen').classList.add('hidden'); $('#citizen-portal').classList.add('hidden'); $('#app').classList.remove('hidden'); switchView('dashboard'); }
  function showCitizen() { $('#login-screen').classList.add('hidden'); $('#app').classList.add('hidden'); $('#citizen-portal').classList.remove('hidden'); window.scrollTo(0, 0); }

  function openModal(kind, data = null) {
    const content = $('#modal-content');
    if (kind === 'act') content.innerHTML = `<h2 id="modal-title">Enregistrer un nouvel acte</h2><p>Les informations seront enregistrées dans la base sécurisée puis soumises à validation.</p><form id="act-form"><div class="form-grid"><label>Type d'acte<select name="type" required><option>Naissance</option><option>Mariage</option><option>Décès</option></select></label><label>Centre d'état civil<input value="Centre d’état civil de Logpom/Andem" disabled /></label><label class="wide">Personne concernée<input name="person" required placeholder="Ex. Nom Prénom" autocomplete="name" /></label><label>Date de l'événement<input name="eventDate" type="date" required /></label><label>Lieu de l'événement<input name="place" required placeholder="Ex. Douala" /></label><label class="wide">Observations<textarea name="notes" placeholder="Informations complémentaires (facultatif)"></textarea></label></div><div class="modal-actions"><button class="outline-button" type="button" data-close-modal>Annuler</button><button class="primary-button" type="submit">Enregistrer l'acte</button></div></form>`;
    if (kind === 'request') content.innerHTML = `<h2 id="modal-title">Faire une demande</h2><p>Votre demande est transmise en toute sécurité au Centre d’état civil de Logpom/Andem.</p><form id="public-request-form"><div class="form-grid"><label>Type de document<select name="document"><option>Extrait de naissance</option><option>Copie intégrale</option><option>Extrait de mariage</option><option>Extrait de décès</option></select></label><label>Référence de l'acte<input name="act" required placeholder="Ex. NAI-2020-00125" /></label><label>Nom complet du demandeur<input name="name" value="${escape(state.user?.name || '')}" required placeholder="Votre nom et prénom" autocomplete="name" /></label><label>Adresse e-mail<input name="email" type="email" value="${escape(state.user?.email || '')}" required placeholder="vous@exemple.cm" autocomplete="email" /></label><label class="wide">Motif de la demande<textarea name="reason" placeholder="Ex. Dossier de scolarité"></textarea></label></div><div class="modal-actions"><button class="outline-button" type="button" data-close-modal>Annuler</button><button class="primary-button" type="submit">Envoyer ma demande</button></div></form>`;
    if (kind === 'mention') content.innerHTML = `<h2 id="modal-title">Ajouter une mention marginale</h2><p>Cette mention est datée, attribuée à son auteur et conservée avec l'acte.</p><form id="mention-form"><div class="form-grid"><label>Acte concerné<input name="act" required placeholder="Ex. MAR-2021-00114" /></label><label>Type de mention<select name="type"><option>Divorce</option><option>Reconnaissance</option><option>Rectification</option><option>Séparation de corps</option></select></label><label class="wide">Référence du document source<input name="source" required placeholder="Ex. Jugement N° 245/TC/2026" /></label><label class="wide">Observations<textarea name="notes" placeholder="Précisions nécessaires à la lecture de la mention"></textarea></label></div><div class="modal-actions"><button class="outline-button" type="button" data-close-modal>Annuler</button><button class="primary-button" type="submit">Ajouter la mention</button></div></form>`;
    if (kind === 'user') content.innerHTML = `<h2 id="modal-title">Inviter un utilisateur</h2><p>Un e-mail d’invitation permettra à cette personne de définir elle-même son mot de passe.</p><form id="user-form"><div class="form-grid"><label>Nom complet<input name="name" required placeholder="Nom et prénom" /></label><label>Adresse e-mail<input name="email" type="email" required placeholder="nom@centre.cm" /></label><label class="wide">Rôle<select name="role"><option value="agent">Agent d’état civil</option><option value="officer">Officier d’état civil</option><option value="citizen">Citoyen</option><option value="auditor">Auditeur</option><option value="admin">Administrateur système</option></select></label></div><div class="modal-actions"><button class="outline-button" type="button" data-close-modal>Annuler</button><button class="primary-button" type="submit">Envoyer l’invitation</button></div></form>`;
    if (kind === 'request-detail') {
      const req = data; const stages = ['Reçue', 'En traitement', 'Validée', 'Prête']; const current = Math.max(0, stages.indexOf(req.status));
      const button = !internal() ? '<button class="outline-button" type="button" data-close-modal>Fermer</button>' : req.status === 'Reçue' ? `<button class="primary-button" data-request-progress="${req.id}">Prendre en charge</button>` : req.status === 'En traitement' ? `<button class="primary-button" data-request-progress="${req.id}">Marquer prête</button>` : `<button class="primary-button" data-download-request="${req.id}">${icon('i-download')} Document PDF</button>`;
      content.innerHTML = `<h2 id="modal-title">Demande ${escape(req.ref)}</h2><p>Suivez l'avancement du dossier et mettez à jour son statut si nécessaire.</p><div class="detail-card"><p><b>Demandeur :</b> ${escape(req.name)}</p><p><b>Document :</b> ${escape(req.document)}</p><p><b>Acte concerné :</b> ${escape(req.act)}</p><p><b>Contact :</b> ${escape(req.email)}</p></div><div class="status-stepper">${stages.map((stage, index) => `<span class="step ${index <= current ? 'active' : ''}">${stage}</span>`).join('')}</div><div class="modal-actions"><button class="outline-button" type="button" data-close-modal>Fermer</button>${button}</div>`;
    }
    $('#modal-layer').classList.remove('hidden'); const input = $('#modal-content input, #modal-content select'); if (input) input.focus();
  }
  const closeModal = () => $('#modal-layer').classList.add('hidden');

  async function loadBootstrap() {
    const data = await request('/bootstrap'); state.user = data.user; state.centre = data.centre || null; state.acts = data.acts || []; state.requests = data.requests || []; state.mentions = data.mentions || []; state.stats = data.stats || {}; state.audit = data.audit || [];
    if (state.user.role === 'citizen') { renderRequests(); showCitizen(); } else { renderAll(); showInternal(); }
  }
  async function signIn(email, password) {
    const response = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'Content-Type': 'application/json' } }); state.token = response.token; state.refreshToken = response.refreshToken; localStorage.setItem(tokenKey, response.token); if (response.refreshToken) localStorage.setItem(refreshKey, response.refreshToken); await loadBootstrap();
  }
  async function refresh() { await loadBootstrap(); }

  document.addEventListener('click', async event => {
    const nav = event.target.closest('.nav-item'); if (nav) return switchView(nav.dataset.view);
    const go = event.target.closest('[data-go]'); if (go) return switchView(go.dataset.go);
    const modalButton = event.target.closest('[data-open-modal]'); if (modalButton) return openModal(modalButton.dataset.openModal);
    if (event.target.closest('#modal-close, [data-close-modal]')) return closeModal(); if (event.target === $('#modal-layer')) return closeModal();
    const detail = event.target.closest('.request-detail-button'); if (detail) return openModal('request-detail', state.requests.find(req => String(req.id) === String(detail.dataset.id)));
    const validate = event.target.closest('.act-validate'); if (validate) { try { const id = validate.dataset.id; await post(`/acts/${id}/validate`, {}); await refresh(); showToast('L’acte a été validé et tracé dans le journal.'); } catch (error) { showToast(error.message, true); } return; }
    const progress = event.target.closest('[data-request-progress]'); if (progress) { try { const id = progress.dataset.requestProgress; const req = state.requests.find(item => String(item.id) === String(id)); await post(`/requests/${id}/progress`, {}); await refresh(); const updated = state.requests.find(item => String(item.id) === String(id)); openModal('request-detail', updated); showToast(`La demande ${updated.ref} a été mise à jour.`); } catch (error) { showToast(error.message, true); } return; }
    if (event.target.closest('[data-download-request]')) { showToast('Le document sécurisé est prêt à être téléchargé.'); return; }
    const filter = event.target.closest('.summary-tile'); if (filter) { $$('.summary-tile').forEach(item => item.classList.remove('selected')); filter.classList.add('selected'); renderRequests(); return; }
    if (event.target.closest('#citizen-switch')) { showCitizen(); return; }
    if (event.target.closest('#back-office')) { showInternal(); return; }
    if (event.target.closest('#mobile-menu')) { $('#sidebar').classList.toggle('open'); return; }
    if (event.target.closest('#export-requests, #export-report')) { showToast('Votre export est en cours de préparation.'); return; }
    if (event.target.closest('.public-login')) { showLogin(); return; }

    if (event.target.closest('#toggle-password')) { const input = $('#login-password'); input.type = input.type === 'password' ? 'text' : 'password'; return; }
    if (event.target.closest('#logout-button')) { try { await post('/auth/logout', {}); } catch {} state.token = null; state.refreshToken = null; state.user = null; state.centre = null; localStorage.removeItem(tokenKey); localStorage.removeItem(refreshKey); showLogin(); return; }
  });
  document.addEventListener('input', event => { if (event.target.matches('#registry-search')) renderActs(); if (event.target.matches('#request-search')) renderRequests(); });
  document.addEventListener('change', event => { if (event.target.matches('#registry-type, #registry-status')) renderActs(); if (event.target.matches('#request-type')) renderRequests(); });
  document.addEventListener('submit', async event => {
    if (event.target.id === 'login-form') { event.preventDefault(); const form = new FormData(event.target); const button = $('.login-submit', event.target); button.disabled = true; button.textContent = 'Connexion…'; try { await signIn(form.get('email'), form.get('password')); } catch (error) { $('#login-error').textContent = error.message.includes('fetch') ? 'Serveur inaccessible. Lancez l’application via la commande indiquée dans le guide.' : error.message; $('#login-error').classList.remove('hidden'); } finally { button.disabled = false; button.innerHTML = `Se connecter ${icon('i-arrow')}`; } }
    if (event.target.id === 'act-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { await post('/acts', data); await refresh(); closeModal(); showToast('L’acte a été enregistré et soumis à validation.'); } catch (error) { showToast(error.message, true); } }
    if (event.target.id === 'public-request-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { await post('/requests', data); await refresh(); closeModal(); showToast('Votre demande a été envoyée avec succès.'); } catch (error) { showToast(error.message, true); } }
    if (event.target.id === 'mention-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { await post('/mentions', data); await refresh(); closeModal(); showToast('La mention marginale a été ajoutée au registre.'); } catch (error) { showToast(error.message, true); } }
    if (event.target.id === 'user-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)); try { const result = await post('/users', data); closeModal(); showToast(result.message || 'Invitation envoyée par e-mail.'); } catch (error) { showToast(error.message, true); } }
    if (event.target.id === 'tracking-form') { event.preventDefault(); const code = $('#tracking-code').value.trim().toUpperCase(); const req = state.requests.find(item => item.ref === code); const result = $('#tracking-result'); result.innerHTML = req ? `<b>${escape(req.ref)}</b> — Votre demande est <strong>${escape(req.status)}</strong>.` : '<b>Référence introuvable.</b> Vérifiez le numéro indiqué dans votre e-mail.'; result.classList.remove('hidden'); }
    if (event.target.id === 'verify-form') { event.preventDefault(); const code = $('#verify-code').value.trim().toUpperCase(); const result = $('#verify-result'); try { const response = await request(`/verify/${encodeURIComponent(code)}`); if (!response.valid) throw new Error(response.message || 'Numéro non trouvé.'); result.innerHTML = `<b>${icon('i-check')} Document authentique</b> — ${escape(response.document.type)}, délivré par ${escape(response.document.centre)}.`; result.style.background = '#ddf2ec'; result.style.color = '#187465'; } catch (error) { result.innerHTML = `<b>Numéro non trouvé.</b> ${escape(error.message)}`; result.style.background = '#fff4df'; result.style.color = '#9a6918'; } result.classList.remove('hidden'); }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
  (async () => { if (!state.token) return showLogin(); try { await loadBootstrap(); } catch { localStorage.removeItem(tokenKey); localStorage.removeItem(refreshKey); state.token = null; state.refreshToken = null; showLogin('Votre session a expiré. Veuillez vous reconnecter.'); } })();
})();
