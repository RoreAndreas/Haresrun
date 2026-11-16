/*
 * HARES RUN — application : état, interface, et liens entre les modules.
 *
 * Un trajet se trace point par point : chaque point touché sur la carte
 * prolonge le trajet, le dernier est l'arrivée. En mode Boucle, on revient
 * au départ. Un trajet généré, chargé ou partagé garde son tracé exact
 * (« figé ») tant qu'on ne modifie pas ses points.
 */
(() => {
  'use strict';
  const { fmt, LS, uid, esc, toast, encodePolyline, decodePolyline, simplify, cumulative } = HR;
  const CFG = Object.assign({ defaultCenter: { lat: 5.3364, lng: -4.0267 }, defaultZoom: 14 }, window.HARES_CONFIG || {});
  const MV = HR.mapview, COLORS = MV.COLORS;
  const STYLE_ORDER = ['epure', 'complete', 'satellite'];
  const MAX_POINTS = 60;

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  // ---------- état ----------
  const saved = LS.get('state', {});
  const state = {
    points: Array.isArray(saved.points) ? saved.points.filter(p => p && isFinite(p.lat) && isFinite(p.lng)) : [],
    loop: !!saved.loop,
    roads: saved.roads !== false,
    name: typeof saved.name === 'string' ? saved.name : '',
    targetSec: saved.targetSec > 0 ? saved.targetSec : null,
    paceSec: saved.paceSec > 0 ? saved.paceSec : null,
    lastEdited: saved.lastEdited === 'pace' ? 'pace' : 'time',
    withMap: saved.withMap !== false,
    style: STYLE_ORDER.includes(saved.style) ? saved.style : 'epure',
    mode: saved.mode === 'random' ? 'random' : 'draw',
    randKm: saved.randKm > 0 ? saved.randKm : 5,
    fixed: saved.fixed && saved.fixed.sig ? saved.fixed : null, // { sig, path (encodé), distance, source }
    savedId: saved.savedId || null,
  };
  let route = null, gain = null, myPos = null, routeToken = 0, routeTimer = null, warnedStraight = false;
  const undoStack = [];
  const save = () => LS.set('state', state);

  // ---------- points et rôles ----------
  const role = (i, n = state.points.length) => (i === 0 ? 'start' : !state.loop && i === n - 1 ? 'finish' : 'via');
  const badge = i => (role(i) === 'start' ? 'D' : role(i) === 'finish' ? 'A' : String(i));
  const roleLabel = i => (role(i) === 'start' ? (state.loop ? 'Départ et arrivée' : 'Départ') : role(i) === 'finish' ? 'Arrivée' : `Étape ${i}`);
  const stops = () => (state.points.length < 2 ? [] : state.loop ? [...state.points, state.points[0]] : state.points.slice());
  const sig = () => JSON.stringify([state.loop, state.points.map(p => [+p.lat.toFixed(6), +p.lng.toFixed(6)])]);

  function snapshot() {
    undoStack.push(JSON.stringify({ points: state.points, loop: state.loop, fixed: state.fixed }));
    if (undoStack.length > 50) undoStack.shift();
  }
  function undo() {
    const last = undoStack.pop();
    if (!last) return toast('Rien à annuler');
    Object.assign(state, JSON.parse(last));
    $('#loop').checked = state.loop;
    refresh();
  }

  function addPoint(ll, label = '') {
    if (state.points.length >= MAX_POINTS) return toast(`Maximum ${MAX_POINTS} points par trajet`);
    snapshot();
    // Tracé manuel : l'arrivée est le dernier point touché. Prolonger une
    // boucle générée la transforme donc en aller simple jusqu'à ce point.
    if (!state.points.length) setLoop(false); // nouveau tracé : aller simple par défaut
    else if (state.loop && state.fixed && state.fixed.source === 'generated') {
      setLoop(false);
      toast('L’arrivée est maintenant le dernier point touché.');
    }
    const p = { id: uid(), lat: ll.lat, lng: ll.lng, label };
    state.points.push(p);
    if (!label) nameIt(p);
    refresh();
  }
  function setLoop(on) {
    state.loop = !!on;
    $('#loop').checked = state.loop;
  }
  function setStart(ll) {
    snapshot();
    if (state.points.length) Object.assign(state.points[0], { lat: ll.lat, lng: ll.lng, label: '' });
    else state.points.push({ id: uid(), lat: ll.lat, lng: ll.lng, label: '' });
    nameIt(state.points[0]);
    refresh();
  }
  function removePoint(id) {
    snapshot();
    state.points = state.points.filter(p => p.id !== id);
    refresh();
  }
  function clearAll() {
    if (!state.points.length) return;
    snapshot();
    state.points = [];
    state.fixed = null;
    state.savedId = null;
    setLoop(false); // un nouveau tracé repart en aller simple
    refresh();
    toast('Trajet effacé. « Annuler » pour revenir en arrière.');
  }
  async function nameIt(p) {
    const { lat, lng } = p;
    const label = await HR.services.reverse(lat, lng);
    if (state.points.includes(p) && !p.label && p.lat === lat && p.lng === lng) {
      p.label = label;
      save(); renderPoints();
    }
  }

  function refresh() {
    save();
    renderPins();
    renderPoints();
    renderRandomFrom();
    scheduleRoute();
    prefetchStreets();
  }

  // ---------- carte ----------
  function renderPins() {
    MV.setPins(state.points.map((p, i) => ({ ...p, role: role(i), badge: badge(i) })), (i, ll) => {
      snapshot();
      const p = state.points[i];
      Object.assign(p, ll, { label: '' });
      nameIt(p);
      refresh();
    });
  }
  function padding() {
    const sheet = $('#sheet');
    return window.innerWidth >= 900
      ? { top: 80, left: sheet.offsetWidth + 40, right: 70, bottom: 40 }
      : { top: 70, left: 30, right: 70, bottom: sheet.offsetHeight + 20 };
  }
  const fitRoute = () => MV.fit(route ? route.path : state.points, padding());

  function onMapClick(ll) {
    if (document.body.classList.contains('is-following')) return;
    if (state.mode === 'random') {
      // en mode aléatoire, toucher la carte choisit le départ de la boucle
      snapshot();
      state.points = [{ id: uid(), lat: ll.lat, lng: ll.lng, label: '' }];
      state.fixed = null; state.savedId = null;
      nameIt(state.points[0]);
      refresh();
      return;
    }
    addPoint(ll);
  }

  // ---------- itinéraire ----------
  function scheduleRoute(fitAfter = false) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => computeRoute(fitAfter), 250);
  }
  async function computeRoute(fitAfter, draw = true) {
    const s = stops(), token = ++routeToken;
    if (s.length < 2) { route = null; gain = null; MV.setRoute(null); renderStats(); return; }
    let r = null, failed = false;
    if (state.fixed && state.fixed.sig === sig()) {
      const path = decodePolyline(state.fixed.path);
      r = { path, distance: state.fixed.distance, legs: [], source: state.fixed.source || 'fixed' };
    } else {
      state.fixed = null;
      if (state.roads) {
        try { r = await HR.services.route(s); } catch (e) { console.warn('Itinéraire :', e.message); failed = true; }
      }
      if (token !== routeToken) return;
      if (!r) r = HR.services.straight(s);
    }
    route = r; gain = null;
    if (draw) MV.setRoute(r.path, { straight: r.source === 'straight' });
    renderStats();
    if (fitAfter) fitRoute();
    if (failed && !warnedStraight) {
      warnedStraight = true;
      toast('Service d’itinéraire indisponible pour le moment : tracé en ligne droite.', 6000);
    }
    // dénivelé en arrière-plan : on n'attend pas la réponse pour continuer
    HR.services.elevation(r.path, r.distance)
      .then(e => { if (token === routeToken && e) { gain = e.gain; renderStats(); } })
      .catch(e => console.warn('Altitude :', e.message));
  }

  /**
   * Remplace le trajet courant par un tracé connu (généré, chargé, partagé).
   * `fit` : recadrer la carte ; `draw` : afficher le tracé tout de suite
   * (non quand il va être dessiné en animation).
   */
  function loadRoute({ points, loop, path, distance, source, name, id }, { fit = true, draw = true } = {}) {
    snapshot();
    state.points = points.map(p => ({ id: uid(), lat: p.lat, lng: p.lng, label: p.label || '' }));
    state.loop = !!loop;
    state.name = name || state.name;
    state.savedId = id || null;
    state.fixed = { sig: sig(), path: typeof path === 'string' ? path : encodePolyline(path), distance, source: source || 'fixed' };
    $('#loop').checked = state.loop;
    state.points.forEach(p => { if (!p.label) nameIt(p); });
    save(); renderPins(); renderPoints(); renderRandomFrom();
    clearTimeout(routeTimer);
    return computeRoute(fit, draw);
  }

  // ---------- panneau ----------
  function renderPoints() {
    const n = state.points.length;
    $('#hint').textContent = n === 0 ? 'Touche la carte pour placer le départ.'
      : n === 1 ? 'Touche la carte pour placer le point suivant.'
        : state.loop ? 'Chaque point touché prolonge le trajet, qui revient au départ.'
          : 'Chaque point touché prolonge le trajet. Le dernier est l’arrivée.';
    const ol = $('#points');
    ol.innerHTML = '';
    state.points.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = `pt pt--${role(i)}`;
      li.innerHTML = `<span class="pt__badge">${badge(i)}</span><span class="pt__name"></span><button class="pt__del" type="button" aria-label="Supprimer">×</button>`;
      const name = li.querySelector('.pt__name');
      name.textContent = p.label || '…';
      name.title = `${roleLabel(i)} — ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      name.onclick = () => MV.map && MV.map.easeTo({ center: [p.lng, p.lat] });
      li.querySelector('.pt__del').onclick = () => removePoint(p.id);
      ol.appendChild(li);
    });
  }

  /**
   * Préchargement des rues dès qu'une boucle devient probable (onglet
   * Aléatoire ouvert, départ ou distance changés) : au moment de toucher
   * « Générer », elles sont déjà là.
   */
  let prefetchTimer;
  function prefetchStreets() {
    if (state.mode !== 'random') return;
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const c = MV.map && MV.map.getCenter();
      const start = state.points[0] || myPos || (c && { lat: c.lat, lng: c.lng });
      HR.gen.prefetch(start, state.randKm * 1000);
    }, 400);
  }

  function renderRandomFrom() {
    $('#rand-km').value = state.randKm;
    $('#rand-from').textContent = state.points.length
      ? `Départ : ${state.points[0].label || 'le point D'}. Touche la carte pour en choisir un autre.`
      : 'Départ : ta position. Touche la carte pour choisir un autre départ.';
  }

  function renderStats() {
    const d = route ? route.distance : 0;
    $('#sum-dist').textContent = fmt.km(d);
    $('#follow-btn').disabled = !route;
    updatePace();
  }

  function setMode(m) {
    state.mode = m; save();
    $$('.seg__btn[data-mode]').forEach(b => b.classList.toggle('is-on', b.dataset.mode === m));
    $$('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== m));
    prefetchStreets();
  }

  // ---------- allure ----------
  const tIn = ['#t-h', '#t-m'].map($), pIn = ['#p-m', '#p-s'].map($);
  const num = el => Math.max(0, parseInt(el.value, 10) || 0);
  function updatePace() {
    const km = route ? route.distance / 1000 : 0;
    if (km > 0) {
      if (state.lastEdited === 'time' && state.targetSec) state.paceSec = state.targetSec / km;
      else if (state.lastEdited === 'pace' && state.paceSec) state.targetSec = state.paceSec * km;
    }
    save();
    const a = document.activeElement;
    if (!tIn.includes(a)) {
      const t = state.targetSec ? Math.round(state.targetSec / 60) : 0;
      tIn[0].value = t ? Math.floor(t / 60) : '';
      tIn[1].value = t ? fmt.pad(t % 60) : '';
    }
    if (!pIn.includes(a)) {
      const p = state.paceSec ? Math.round(state.paceSec) : 0;
      pIn[0].value = p ? Math.floor(p / 60) : '';
      pIn[1].value = p ? fmt.pad(p % 60) : '';
    }
    const meta = [];
    if (gain != null) meta.push(`D+ ${Math.round(gain)} m`);
    if (state.paceSec && km) meta.push(`${fmt.pace(state.paceSec)} /km`);
    if (state.targetSec && km) meta.push(fmt.dur(state.targetSec));
    $('#sum-meta').textContent = meta.join(' · ');
  }
  tIn.forEach(el => el.addEventListener('input', () => {
    const t = num(tIn[0]) * 3600 + num(tIn[1]) * 60;
    state.targetSec = t || null; state.lastEdited = 'time';
    if (!t) state.paceSec = null;
    updatePace();
  }));
  pIn.forEach(el => el.addEventListener('input', () => {
    const p = num(pIn[0]) * 60 + num(pIn[1]);
    state.paceSec = p || null; state.lastEdited = 'pace';
    if (!p) state.targetSec = null;
    updatePace();
  }));
  [...tIn, ...pIn].forEach(el => el.addEventListener('blur', () => setTimeout(updatePace)));

  // ---------- position ----------
  const fixListeners = new Set();
  let lastFix = null, locating = false, locateRun = 0;
  function setMyPos(pos) {
    myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    MV.setMe(myPos);
  }
  function startWatch() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(pos => {
      lastFix = { pos, time: Date.now() };
      fixListeners.forEach(f => f(pos));
      if (!locating && !HR.follow.active) setMyPos(pos);
    }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  /** Meilleure position en quelques secondes (jusqu'à ±10 m), repli en précision normale. */
  function bestPosition(maxWait, quiet) {
    return new Promise((resolve, reject) => {
      let best = null, id = null, timer = null;
      const finish = err => {
        if (id != null) navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        fixListeners.delete(consider);
        if (best) return resolve(best);
        if (err) return reject(err);
        navigator.geolocation.getCurrentPosition(resolve, e => reject(e || { code: 3 }), { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
      };
      function consider(pos) {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        setMyPos(best);
        if (!quiet) toast(`Localisation… ±${Math.round(best.coords.accuracy)} m`, maxWait);
        if (best.coords.accuracy <= 10) finish();
      }
      fixListeners.add(consider);
      timer = setTimeout(() => finish(), maxWait);
      id = navigator.geolocation.watchPosition(consider, err => { if (err.code === 1) finish(err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: maxWait });
      if (lastFix && Date.now() - lastFix.time < 10000) consider(lastFix.pos);
    });
  }
  function geoError(err) {
    if (!window.isSecureContext) return 'La localisation exige une adresse en https://.';
    if (err.code === 1) return 'Localisation refusée : autorise-la pour ce site (icône à gauche de l’adresse).';
    if (err.code === 2) return 'Position indisponible : active la localisation de l’appareil.';
    return 'Ton appareil ne donne pas sa position. Sur ordinateur, vérifie que la localisation est activée (voir l’aide du site).';
  }
  /** Rend la position, ou null. `quiet` : sans messages. */
  async function locate({ quiet = false, center = true } = {}) {
    if (!navigator.geolocation) { if (!quiet) toast('Cet appareil ne fournit pas sa position'); return null; }
    const run = ++locateRun;
    locating = true;
    if (!quiet) toast('Localisation en cours…', 25000);
    try {
      const pos = await bestPosition(quiet ? 6000 : 12000, quiet);
      if (run !== locateRun) return null;
      setMyPos(pos);
      if (center && MV.map) MV.map.easeTo({ center: [myPos.lng, myPos.lat], zoom: Math.max(MV.map.getZoom(), 15) });
      if (!quiet) toast(`Position trouvée (±${Math.round(myPos.acc)} m)`, 3000);
      return myPos;
    } catch (err) {
      if (run === locateRun && (!quiet || err.code === 1)) toast(geoError(err), 8000);
      return null;
    } finally {
      if (run === locateRun) locating = false;
    }
  }

  // ---------- boucle aléatoire ----------
  // Génération : le bouton montre l'étape en cours et le temps écoulé ;
  // le toucher pendant la génération l'annule.
  let genCtrl = null;
  const STAGES = {
    position: 'Recherche de ta position',
    download: 'Chargement des rues',
    slow: 'Téléchargement des rues (serveur lent)',
    explore: 'Exploration des rues',
    build: 'Construction de la boucle',
    fallback: 'Calcul de la boucle (sans animation)',
  };
  async function generateLoop() {
    if (genCtrl) { genCtrl.abort(); return; }
    const km = Math.max(1, Math.min(42, parseFloat(String($('#rand-km').value).replace(',', '.')) || 5));
    state.randKm = km; save();
    const ctrl = genCtrl = new AbortController();
    const btn = $('#gen-btn'), bar = $('#gen-bar'), t0 = Date.now();
    let stage = 'position';
    const show = () => { $('#gen-status').textContent = `${STAGES[stage]}… ${Math.round((Date.now() - t0) / 1000)} s`; };
    const timer = setInterval(show, 500);
    btn.textContent = 'Annuler';
    btn.classList.remove('btn--accent');
    bar.hidden = false;
    show();
    if (window.innerWidth < 900) collapseSheet(true); // la carte entière pour voir l'exploration
    try {
      let start = state.points[0] || myPos;
      if (!start) start = await locate({ quiet: true, center: false });
      if (ctrl.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });
      if (!start) { const c = MV.map.getCenter(); start = { lat: c.lat, lng: c.lng }; toast('Position inconnue : boucle depuis le centre de la carte.', 4000); }
      // cadrage sur la zone explorée
      const r = km * 1000 / (2 * Math.PI * 1.3) * 2.2;
      MV.fit([HR.offset(start, r, 0), HR.offset(start, r, 90), HR.offset(start, r, 180), HR.offset(start, r, 270)], padding());
      MV.setRoute(null);
      let anim = null;
      const res = await HR.gen.generate(start, km * 1000, {
        signal: ctrl.signal,
        onStage: s => { stage = s; show(); if (s === 'fallback') toast('Le service des rues ne répond pas : boucle calculée sans l’animation.', 5000); },
        // animation en 2,5 s : la vague d'exploration (1,8 s, pendant que les
        // boucles sont calculées), puis le tracé retenu qui se dessine (0,7 s)
        onExplore: fc => { MV.setExplore(fc); anim = MV.animateExplore(1800); },
      });
      if (anim) await anim;
      if (ctrl.signal.aborted) throw Object.assign(new Error(), { name: 'AbortError' });
      clearInterval(timer);
      bar.hidden = true;
      MV.dimExplore();
      await loadRoute({ points: res.points, loop: true, path: res.path, distance: res.distance, source: 'generated', name: `Boucle de ${fmt.km1(res.distance)} km` }, { fit: false, draw: false });
      await MV.animateRoute(res.path, anim ? 700 : 1200);
      MV.fadeExplore();
      fitRoute();
      toast(`Boucle de ${fmt.km(res.distance)} km. « Générer » à nouveau pour une autre.`, 4000);
    } catch (e) {
      MV.fadeExplore();
      scheduleRoute(); // remet le trajet d'avant à l'écran
      if (e.name === 'AbortError') toast('Génération annulée.');
      else { console.warn(e); toast(e.message || 'Impossible de générer une boucle ici.', 6000); }
    } finally {
      clearInterval(timer);
      bar.hidden = true;
      genCtrl = null;
      btn.textContent = 'Générer une boucle';
      btn.classList.add('btn--accent');
    }
  }

  // ---------- suivi GPS ----------
  let autoCenter = true, followCum = null;
  function startFollow() {
    if (!route) return toast('Trace ou charge d’abord un trajet.');
    document.body.classList.add('is-following');
    $('#follow-ui').hidden = false;
    autoCenter = true;
    followCum = cumulative(route.path);
    setStatus('En attente du GPS…', '');
    $('#f-hares').hidden = true;
    $('#f-rem').textContent = fmt.km(route.distance);
    $('#f-done').textContent = '0,00'; $('#f-time').textContent = '0:00'; $('#f-pace').textContent = '—';
    if (route.path[0]) MV.map.easeTo({ center: [route.path[0].lng, route.path[0].lat], zoom: 16 });
    HR.follow.start(route.path, {
      onUpdate: s => {
        MV.setMe(s.pos);
        $('#f-rem').textContent = fmt.km(s.remaining);
        $('#f-done').textContent = fmt.km(s.progress);
        $('#f-time').textContent = fmt.dur(s.elapsed);
        $('#f-pace').textContent = fmt.pace(s.pace);
        MV.setDone(donePath(s.progress));
        if (s.offRoute) setStatus(s.offBy != null ? `Hors parcours — ${Math.round(s.offBy)} m` : 'Hors parcours', 'is-off');
        else if (s.remaining > 30) setStatus(s.progress < 20 ? 'Sur le parcours — c’est parti !' : 'Sur le parcours', 'is-ok');
        if (autoCenter) MV.map.easeTo({ center: [s.pos.lng, s.pos.lat], duration: 600 });
      },
      onFinish: s => { setStatus(`Arrivée ! ${fmt.km(s.progress)} km en ${fmt.dur(s.elapsed)}`, 'is-done'); $('#f-hares').hidden = false; },
      onError: err => setStatus(geoError(err), 'is-off'),
    });
  }
  function donePath(progress) {
    const p = route.path, cum = followCum, out = [p[0]];
    for (let i = 1; i < p.length; i++) {
      if (cum[i] <= progress) { out.push(p[i]); continue; }
      const t = (progress - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      out.push({ lat: p[i - 1].lat + (p[i].lat - p[i - 1].lat) * t, lng: p[i - 1].lng + (p[i].lng - p[i - 1].lng) * t });
      break;
    }
    return out;
  }
  function setStatus(text, cls) {
    const el = $('#f-status');
    el.textContent = text;
    el.className = 'follow__status ' + cls;
  }
  function stopFollow() {
    HR.follow.stop();
    document.body.classList.remove('is-following');
    $('#follow-ui').hidden = true;
    MV.setDone(null);
    if (myPos) MV.setMe(myPos);
  }

  // ---------- partage par lien ----------
  // Le trajet entier tient dans l'adresse (après #) : pas besoin de compte
  // pour ouvrir un lien partagé, et rien n'est envoyé à un serveur.
  const b64 = {
    enc: s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))),
  };
  function shareLink() {
    const data = {
      v: 1, n: state.name || '', l: state.loop ? 1 : 0, d: Math.round(route.distance),
      s: route.source === 'straight' ? 1 : 0,
      p: encodePolyline(state.points), g: encodePolyline(simplify(route.path, 3)),
    };
    return `${location.origin}${location.pathname}#t=${b64.enc(JSON.stringify(data))}`;
  }
  async function share() {
    if (!route) return toast('Pas encore de trajet à partager.');
    const url = shareLink(), title = state.name || `Trajet de ${fmt.km(route.distance)} km`;
    if (navigator.share) {
      try { await navigator.share({ title: `HARES RUN — ${title}`, text: `${title} (${fmt.km(route.distance)} km)`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Lien copié : envoie-le à qui tu veux.'); }
    catch { window.prompt('Copie ce lien :', url); }
  }
  function readSharedLink() {
    const m = location.hash.match(/^#t=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    window.history.replaceState(null, '', location.pathname + location.search);
    try {
      const d = JSON.parse(b64.dec(m[1]));
      const points = decodePolyline(d.p), path = decodePolyline(d.g);
      if (points.length < 2 || path.length < 2) return null;
      return { points, path: d.g, loop: !!d.l, distance: d.d, source: d.s ? 'straight' : 'shared', name: d.n };
    } catch (e) {
      console.warn('Lien partagé illisible :', e.message);
      toast('Ce lien de trajet est incomplet ou abîmé.');
      return null;
    }
  }

  // ---------- bibliothèque ----------
  function currentRecord(name) {
    return {
      id: state.savedId, name, distance: route.distance, gain, loop: state.loop,
      points: state.points.map(p => ({ lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), label: p.label || '' })),
      path: encodePolyline(simplify(route.path, 2)), source: route.source,
    };
  }
  function openSave() {
    if (!route) return toast('Pas encore de trajet à enregistrer.');
    $('#save-name').value = state.name || `Trajet de ${fmt.km1(route.distance)} km`;
    $('#save-where').textContent = HR.store.user ? 'Dans ton compte.' : HR.store.enabled
      ? 'Sur cet appareil. Connecte-toi pour retrouver tes trajets partout.' : 'Sur cet appareil.';
    $('#save-dialog').showModal();
  }
  async function doSave(e) {
    e.preventDefault();
    const name = $('#save-name').value.trim() || 'Trajet';
    try {
      const rec = await HR.store.save(currentRecord(name));
      state.savedId = rec.id; state.name = name; save();
      $('#save-dialog').close();
      toast(HR.store.user ? 'Trajet enregistré dans ton compte.' : 'Trajet enregistré sur cet appareil.');
    } catch (err) { toast(err.message, 6000); }
  }
  function miniature(path) {
    const pts = simplify(decodePolyline(path), 15);
    if (pts.length < 2) return '<svg viewBox="0 0 46 46"></svg>';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const xy = pts.map(p => { const x = p.lng, y = -Math.log(Math.tan(Math.PI / 4 + p.lat * Math.PI / 360)); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); return [x, y]; });
    const k = 36 / Math.max(x1 - x0, (y1 - y0) * 180 / Math.PI, 1e-9);
    const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${(23 + (x - (x0 + x1) / 2) * k).toFixed(1)} ${(23 + (y - (y0 + y1) / 2) * k * 180 / Math.PI).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 46 46"><path d="${d}" fill="none" stroke="${COLORS.route}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  async function openLibrary() {
    const dlg = $('#library-dialog'), ul = $('#library-list');
    $('#library-where').textContent = HR.store.user ? `Trajets de ${HR.store.user.email}.`
      : HR.store.enabled ? 'Trajets gardés sur cet appareil. Connecte-toi pour les retrouver partout.' : 'Trajets gardés sur cet appareil.';
    const n = HR.store.localCount(), imp = $('#import-btn');
    imp.hidden = !(HR.store.user && n);
    imp.textContent = `Ajouter à mon compte les ${n} trajet${n > 1 ? 's' : ''} de cet appareil`;
    ul.innerHTML = '<li class="empty">Chargement…</li>';
    if (!dlg.open) dlg.showModal();
    let list;
    try { list = await HR.store.list(); } catch (e) { ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`; return; }
    if (!list.length) { ul.innerHTML = '<li class="empty"><i class="hares hares--stand hares--x4" aria-hidden="true"></i>Aucun trajet enregistré pour l’instant.<br>Trace ou génère un trajet, puis « Enregistrer ».</li>'; return; }
    ul.innerHTML = '';
    list.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `${miniature(r.path)}
        <div class="lib-main"><b>${esc(r.name)}</b><span class="muted small">${fmt.km(r.distance)} km${r.loop ? ' · boucle' : ''} · ${fmt.date(r.updated_at || r.created_at)}</span></div>
        <div class="lib-acts"><button class="btn" data-a="follow">Suivre</button><button class="btn" data-a="del" aria-label="Supprimer">×</button></div>`;
      const open = async () => { dlg.close(); await loadRoute({ ...r, id: r.id }); };
      li.querySelector('.lib-main').onclick = open;
      li.querySelector('[data-a="follow"]').onclick = async () => { await open(); startFollow(); };
      li.querySelector('[data-a="del"]').onclick = async () => {
        if (!confirm(`Supprimer « ${r.name} » ?`)) return;
        try { await HR.store.remove(r.id); if (state.savedId === r.id) { state.savedId = null; save(); } li.remove(); }
        catch (e) { toast(e.message); }
      };
      ul.appendChild(li);
    });
  }

  // ---------- compte ----------
  let authMode = 'in';
  function setAuthMode(m) {
    authMode = m;
    $$('[data-auth]').forEach(b => b.classList.toggle('is-on', b.dataset.auth === m));
    $('#auth-submit').textContent = m === 'in' ? 'Se connecter' : 'Créer mon compte';
    $('#auth-pass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
    $('[data-action="forgot"]').hidden = m !== 'in';
    authMsg('');
  }
  function authMsg(text, kind = '', el = '#auth-msg') {
    const m = $(el);
    m.hidden = !text; m.textContent = text; m.className = 'small ' + (kind ? 'is-' + kind : '');
  }
  function openAccount(view) {
    const u = HR.store.user;
    $('#account-off').hidden = HR.store.enabled;
    $('#auth-form').hidden = !HR.store.enabled || !!u || view === 'newpass';
    $('#newpass-form').hidden = view !== 'newpass';
    $('#account-in').hidden = !u || view === 'newpass';
    $('#account-title').textContent = view === 'newpass' ? 'Nouveau mot de passe' : u ? 'Mon compte' : HR.store.enabled ? 'Connexion' : 'Compte';
    if (u) $('#account-email').textContent = u.email;
    const d = $('#account-dialog');
    if (!d.open) d.showModal();
  }
  async function submitAuth(e) {
    e.preventDefault();
    const email = $('#auth-email').value.trim(), pass = $('#auth-pass').value;
    $('#auth-submit').disabled = true;
    try {
      if (authMode === 'in') {
        await HR.store.auth.signIn(email, pass);
      } else {
        const data = await HR.store.auth.signUp(email, pass);
        if (!data.session) { setAuthMode('in'); authMsg('Compte créé. Ouvre le lien reçu par e-mail pour le confirmer, puis connecte-toi.', 'ok'); }
      }
    } catch (err) { authMsg(err.message, 'error'); }
    finally { $('#auth-submit').disabled = false; }
  }
  async function forgot() {
    const email = $('#auth-email').value.trim();
    if (!email) return authMsg('Écris ton e-mail ci-dessus, puis touche « Mot de passe oublié ? ».', 'error');
    try { await HR.store.auth.resetPassword(email); authMsg('Un lien pour changer ton mot de passe vient de t’être envoyé.', 'ok'); }
    catch (err) { authMsg(err.message, 'error'); }
  }
  async function submitNewPass(e) {
    e.preventDefault();
    try { await HR.store.auth.updatePassword($('#newpass').value); $('#account-dialog').close(); toast('Mot de passe changé.'); }
    catch (err) { authMsg(err.message, 'error', '#newpass-msg'); }
  }
  function renderAccountBtn() {
    const btn = $('#account-btn'), u = HR.store.user;
    btn.classList.toggle('is-on', !!u);
    btn.innerHTML = u ? `<span class="account-initial">${esc(u.email[0].toUpperCase())}</span>`
      : '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
  }

  // ---------- image ----------
  function posterData() {
    return {
      name: state.name.trim() || 'Run du ' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }),
      date: new Date(), path: route ? route.path : [], distance: route ? route.distance : 0,
      straight: route && route.source === 'straight', loop: state.loop,
      points: state.points.map((p, i) => ({ lat: p.lat, lng: p.lng, label: p.label, role: role(i), badge: badge(i) })),
      targetSec: state.targetSec, paceSec: state.paceSec, gain,
    };
  }
  async function renderPoster() {
    $('#export-note').textContent = state.withMap ? 'Préparation du fond de carte…' : '';
    const res = await HR.poster.render($('#poster'), posterData(), { withMap: state.withMap, colors: COLORS });
    $('#export-note').textContent = state.withMap && !res.mapUsed ? 'Fond de carte indisponible pour le moment : version sans carte.' : '';
  }
  function openExport() {
    if (!route) return toast('Trace d’abord un trajet.');
    $('#run-name').value = state.name;
    $('#with-map').checked = state.withMap;
    $('#export-dialog').showModal();
    renderPoster();
  }
  function download() {
    $('#poster').toBlob(blob => {
      if (!blob) return toast('Export impossible.');
      const slug = (state.name || 'run').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `hares-run-${slug}-${(route.distance / 1000).toFixed(1)}km.png` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  // ---------- panneau repliable ----------
  // Replié : seulement le résumé (distance, Réglages, Suivre), la carte est
  // libre. Ouvert : tous les réglages, en plein écran sur téléphone.
  function collapseSheet(on) {
    $('#sheet').classList.toggle('is-collapsed', on);
    const btn = $('#details-btn');
    btn.setAttribute('aria-expanded', String(!on));
    btn.querySelector('span').textContent = on ? 'Réglages' : 'Fermer';
  }
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--sheet-h', $('#sheet').offsetHeight + 'px');
  }).observe($('#sheet'));

  // ---------- branchements ----------
  function bind() {
    $('#loop').checked = state.loop;
    $('#loop').addEventListener('change', e => { snapshot(); state.loop = e.target.checked; refresh(); });
    $('#roads').checked = state.roads;
    $('#roads').addEventListener('change', e => { state.roads = e.target.checked; state.fixed = null; warnedStraight = false; save(); scheduleRoute(); });
    $$('.seg__btn[data-mode]').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
    $$('[data-auth]').forEach(b => (b.onclick = () => setAuthMode(b.dataset.auth)));
    $$('[data-step]').forEach(b => (b.onclick = () => {
      const v = Math.max(1, Math.min(42, (parseFloat($('#rand-km').value) || 5) + +b.dataset.step));
      $('#rand-km').value = v; state.randKm = v; save(); prefetchStreets();
    }));
    $('#rand-km').addEventListener('input', e => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (v > 0) { state.randKm = v; save(); prefetchStreets(); } });
    $('#search').addEventListener('submit', e => { e.preventDefault(); search($('#search-input').value); });
    $('#search-input').addEventListener('input', e => { if (!e.target.value) $('#search-results').hidden = true; });
    $('#auth-form').addEventListener('submit', submitAuth);
    $('#newpass-form').addEventListener('submit', submitNewPass);
    $('#save-form').addEventListener('submit', doSave);
    $('#with-map').addEventListener('change', e => { state.withMap = e.target.checked; save(); renderPoster(); });
    let nameTimer;
    $('#run-name').addEventListener('input', e => { state.name = e.target.value; save(); clearTimeout(nameTimer); nameTimer = setTimeout(renderPoster, 400); });
    $$('[data-close]').forEach(b => (b.onclick = () => b.closest('dialog').close()));
    // un toucher hors de la fenêtre (sur le fond assombri) la ferme
    $$('dialog').forEach(d => d.addEventListener('click', e => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    }));

    const actions = {
      'toggle-sheet': () => collapseSheet(!$('#sheet').classList.contains('is-collapsed')),
      'cycle-style': () => {
        state.style = STYLE_ORDER[(STYLE_ORDER.indexOf(state.style) + 1) % STYLE_ORDER.length]; save();
        MV.setStyle(state.style);
        $('#style-btn').textContent = MV.STYLES[state.style].name;
      },
      locate: () => locate(),
      'start-here': async () => { const p = await locate(); if (p) setStart(p); },
      undo, clear: clearAll,
      generate: generateLoop,
      'start-follow': startFollow, 'stop-follow': stopFollow,
      recenter: () => { autoCenter = true; if (myPos) MV.map.easeTo({ center: [myPos.lng, myPos.lat] }); },
      save: openSave, share, 'open-export': openExport, download,
      'open-library': openLibrary,
      'import-local': async () => {
        try { const n = await HR.store.importLocal(); toast(`${n} trajet${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à ton compte.`); openLibrary(); }
        catch (e) { toast(e.message); }
      },
      'open-account': () => openAccount(),
      forgot,
      'sign-out': async () => { try { await HR.store.auth.signOut(); $('#account-dialog').close(); } catch (e) { toast(e.message); } },
      'shared-follow': () => { $('#shared-dialog').close(); startFollow(); },
      'shared-save': () => { $('#shared-dialog').close(); openSave(); },
    };
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](); }
    });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    });
  }

  async function search(q) {
    q = q.trim();
    const box = $('#search-results');
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<li class="muted">Recherche…</li>';
    let results = [];
    const m = q.match(/^\s*(-?\d{1,2}(?:[.]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.]\d+)?)\s*$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) results = [{ name: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, address: 'Coordonnées GPS', lat: +m[1], lng: +m[2] }];
    else {
      const b = MV.map.getBounds();
      try { results = await HR.services.search(q, { west: b.getWest(), east: b.getEast(), north: b.getNorth(), south: b.getSouth() }); } catch (e) { console.warn(e); }
    }
    if (!results.length) { box.innerHTML = '<li class="muted">Aucun résultat</li>'; return; }
    box.innerHTML = '';
    results.slice(0, 6).forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="r-main"><b></b><small></small></div><button class="btn" type="button">Ajouter</button>';
      li.querySelector('b').textContent = r.name;
      li.querySelector('small').textContent = r.address || '';
      li.querySelector('.r-main').onclick = () => { MV.map.easeTo({ center: [r.lng, r.lat], zoom: 16 }); box.hidden = true; };
      li.querySelector('button').onclick = () => { addPoint(r, r.name); MV.map.easeTo({ center: [r.lng, r.lat] }); box.hidden = true; $('#search-input').value = ''; };
      box.appendChild(li);
    });
  }

  // ---------- accès : compte ou clé d'accès ----------
  // L'appli ne s'ouvre qu'à un utilisateur connecté, ou à qui a saisi la clé
  // d'accès. La clé n'est pas écrite en clair : on compare son empreinte
  // SHA-256. C'est un verrou d'interface (le code du site reste public), pas
  // une protection des données — celle-ci vient des règles Supabase.
  const KEY_HASH = '87a8f9d27759d2c3b7fc72d30b7207bd035a0d69a1ff84c1e2de227551f37500';
  const hasKeyAccess = () => LS.get('access') === KEY_HASH;
  let grantAccess;
  const accessGranted = new Promise(r => { grantAccess = r; });
  let gateMode = 'in';

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function openGate() {
    $('#gate-auth').hidden = !HR.store.enabled;
    $('#gate-sep').hidden = !HR.store.enabled;
    $('#gate').hidden = false;
    document.body.classList.add('is-locked');
    document.body.classList.remove('is-booting');
    $$('dialog[open]').forEach(d => d.close());
  }
  function closeGate() {
    $('#gate').hidden = true;
    document.body.classList.remove('is-locked', 'is-booting');
    grantAccess();
  }
  function gateMsg(text, kind = 'error') {
    const m = $('#gate-msg');
    m.hidden = !text; m.textContent = text; m.className = 'small is-' + kind;
  }
  function setGateMode(m) {
    gateMode = m;
    $$('[data-gate]').forEach(b => b.classList.toggle('is-on', b.dataset.gate === m));
    $('#gate-submit').textContent = m === 'in' ? 'Se connecter' : 'Créer mon compte';
    $('#gate-pass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
    $('[data-action="gate-forgot"]').hidden = m !== 'in';
    gateMsg('');
  }
  function bindGate() {
    $$('[data-gate]').forEach(b => (b.onclick = () => setGateMode(b.dataset.gate)));
    $('#gate-auth').addEventListener('submit', async e => {
      e.preventDefault();
      const email = $('#gate-email').value.trim(), pass = $('#gate-pass').value;
      $('#gate-submit').disabled = true;
      try {
        if (gateMode === 'in') await HR.store.auth.signIn(email, pass); // la suite : événement SIGNED_IN
        else {
          const data = await HR.store.auth.signUp(email, pass);
          if (!data.session) { setGateMode('in'); gateMsg('Compte créé. Ouvre le lien reçu par e-mail pour le confirmer, puis connecte-toi.', 'ok'); }
        }
      } catch (err) { gateMsg(err.message); }
      finally { $('#gate-submit').disabled = false; }
    });
    $('[data-action="gate-forgot"]').onclick = async e => {
      e.preventDefault();
      const email = $('#gate-email').value.trim();
      if (!email) return gateMsg('Écris ton e-mail ci-dessus, puis touche « Mot de passe oublié ? ».');
      try { await HR.store.auth.resetPassword(email); gateMsg('Un lien pour changer ton mot de passe vient de t’être envoyé.', 'ok'); }
      catch (err) { gateMsg(err.message); }
    };
    $('#gate-key').addEventListener('submit', async e => {
      e.preventDefault();
      const msg = $('#gate-key-msg');
      if (!window.crypto || !crypto.subtle) { msg.hidden = false; msg.textContent = 'Ouvre le site en https:// pour utiliser la clé.'; return; }
      if (await sha256($('#gate-key-input').value.trim()) === KEY_HASH) {
        LS.set('access', KEY_HASH);
        msg.hidden = true;
        closeGate();
      } else {
        msg.hidden = false; msg.textContent = 'Clé incorrecte.';
        $('#gate-key-input').select();
      }
    });
  }

  // ---------- démarrage ----------
  async function start() {
    bind();
    bindGate();
    collapseSheet(window.innerWidth < 900); // téléphone : la carte d'abord, les réglages sur demande
    setMode(state.mode);
    setAuthMode('in');
    $('#style-btn').textContent = MV.STYLES[state.style].name;
    renderPoints(); renderRandomFrom(); renderStats();

    // compte : session éventuelle, puis décision d'accès
    const storeReady = HR.store.init().catch(e => console.warn('Comptes :', e.message)).then(() => {
      renderAccountBtn();
      if (hasKeyAccess() || HR.store.user) closeGate(); else openGate();
    });
    HR.store.onAuth((event, u) => {
      renderAccountBtn();
      if (event === 'PASSWORD_RECOVERY') { closeGate(); openAccount('newpass'); }
      else if (event === 'SIGNED_IN') {
        if (!$('#gate').hidden) { closeGate(); toast(`Bienvenue, ${u.email}`); }
        else if ($('#account-dialog').open && $('#newpass-form').hidden) { $('#account-dialog').close(); toast(`Connecté : ${u.email}`); }
      } else if (event === 'SIGNED_OUT') {
        toast('Déconnecté.');
        if (!hasKeyAccess()) openGate();
      }
    });

    const shared = readSharedLink();
    if (shared && state.points.length) LS.set('backup', state);
    const center = shared ? shared.points[0] : state.points[0] || CFG.defaultCenter;
    try {
      MV.init('map', { center, zoom: CFG.defaultZoom, style: state.style, onClick: onMapClick });
    } catch (e) {
      console.error(e);
      $('#map-error').hidden = false;
      return;
    }
    MV.map.on('dragstart', () => { if (HR.follow.active) autoCenter = false; });
    MV.map.on('moveend', () => {
      const c = MV.map.getCenter();
      $('#osm-edit').href = `https://www.openstreetmap.org/edit#map=${Math.max(16, Math.round(MV.map.getZoom()))}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
    });
    renderPins();
    if (shared) await loadRoute(shared);
    else scheduleRoute(state.points.length > 1);

    // le reste attend l'accès : pas de demande de localisation derrière l'écran d'entrée
    await storeReady;
    await accessGranted;
    if (shared) {
      $('#shared-title').textContent = shared.name || 'Trajet partagé';
      $('#shared-meta').textContent = `${fmt.km(shared.distance)} km${shared.loop ? ' · boucle' : ''}`;
      $('#shared-dialog').showModal();
    }
    startWatch();
    if (!state.points.length && !shared) locate({ quiet: true }).then(prefetchStreets);
    else prefetchStreets();
  }

  start();
  window.HaresRun = { state, get route() { return route; }, get map() { return MV.map; }, loadRoute, shareLink };
})();
