/*
 * HARES RUN — planificateur de runs sur Google Maps.
 *
 * Un parcours = une liste de points : le premier est le départ, le dernier
 * l'arrivée, ceux du milieu des étapes. En mode « Boucle », l'arrivée revient
 * au départ et tous les points ajoutés sont des étapes.
 *
 * Itinéraire piéton : Routes API (REST), puis le DirectionsService historique
 * si la première n'est pas activée, puis la ligne droite en dernier recours.
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    { googleMapsApiKey: '', defaultCenter: { lat: 5.3364, lng: -4.0267 }, defaultZoom: 14 },
    window.HARES_CONFIG || {}
  );
  const COLORS = { route: '#ff7a1a', start: '#3fa34d', via: '#6b6b6b', finish: '#d64545' };
  const MAX_POINTS = 27; // départ + arrivée + 25 étapes (limite Google à pied)

  const MAP_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#1d1d1d' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8c8c8c' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1d1d' }] },
    { elementType: 'labels.icon', stylers: [{ saturation: -100 }, { lightness: -40 }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#242424' }] },
    { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1f2a1f' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#333333' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#262626' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#404040' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#14191f' }] },
  ];

  // ---------- stockage local ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('haresrun.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('haresrun.' + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
    del(k) { try { localStorage.removeItem('haresrun.' + k); } catch { /* idem */ } },
  };

  // ---------- état ----------
  const saved = LS.get('state', {});
  const state = {
    points: Array.isArray(saved.points) ? saved.points.filter(p => p && isFinite(p.lat) && isFinite(p.lng)) : [],
    loop: !!saved.loop,
    name: typeof saved.name === 'string' ? saved.name : '',
    targetSec: saved.targetSec > 0 ? saved.targetSec : null,
    paceSec: saved.paceSec > 0 ? saved.paceSec : null,
    lastEdited: saved.lastEdited === 'pace' ? 'pace' : 'time',
    withMap: saved.withMap !== false,
  };
  let route = null;      // { path:[{lat,lng}], distance, legs:[m], source }
  let elevation = null;  // { gain, loss, min, max }
  let map = null, geocoder = null, meOverlay = null, myPos = null;
  let markers = [], lines = [], accCircle = null, locating = false;
  let routeToken = 0, routeTimer = null, warnedStraight = false;
  const history = [];

  const $ = s => document.querySelector(s);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const save = () => LS.set('state', state);

  // ---------- formats ----------
  const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pad = n => String(n).padStart(2, '0');
  function fmtDur(sec) {
    if (!(sec > 0)) return '—';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  const fmtPace = sec => (sec > 0 ? `${Math.floor(Math.round(sec) / 60)}:${pad(Math.round(sec) % 60)}` : '—');
  const km = () => (route ? route.distance / 1000 : 0);

  // ---------- géométrie ----------
  function haversine(a, b) {
    const R = 6371008.8, r = Math.PI / 180;
    const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function decodePolyline(str) {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = (result & 1) ? ~(result >> 1) : (result >> 1);
        if (k === 0) lat += d; else lng += d;
      }
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }
  function downsample(path, max) {
    if (path.length <= max) return path;
    const step = (path.length - 1) / (max - 1), out = [];
    for (let i = 0; i < max; i++) out.push(path[Math.round(i * step)]);
    return out;
  }
  const ll = v => (typeof v === 'function' ? v() : v);
  const toLit = p => ({ lat: ll(p.lat), lng: ll(p.lng) });

  // ---------- rôles des points ----------
  function role(i, n = state.points.length) {
    if (i === 0) return 'start';
    if (!state.loop && i === n - 1) return 'finish';
    return 'via';
  }
  function roleLabel(i) {
    const r = role(i);
    if (r === 'start') return state.loop ? 'Départ et arrivée' : 'Départ';
    if (r === 'finish') return 'Arrivée';
    return `Étape ${i}`;
  }
  const badgeText = i => (role(i) === 'start' ? 'D' : role(i) === 'finish' ? 'A' : String(i));
  function stops() {
    const p = state.points;
    if (p.length < 2) return [];
    return state.loop ? [...p, p[0]] : p.slice();
  }

  // ---------- historique ----------
  function snapshot() {
    history.push(JSON.stringify({ points: state.points, loop: state.loop }));
    if (history.length > 50) history.shift();
  }
  function undo() {
    const last = history.pop();
    if (!last) return toast('Rien à annuler');
    const s = JSON.parse(last);
    state.points = s.points; state.loop = s.loop;
    $('#loop').checked = state.loop;
    refresh();
  }

  // ---------- actions sur les points ----------
  /**
   * Ajoute un point. Tant qu'il n'y a pas de départ et d'arrivée, il prend
   * ces rôles ; ensuite c'est une étape, insérée là où elle allonge le moins
   * le parcours — un clic sur le tracé tombe donc dans le bon tronçon.
   */
  function addPoint(lat, lng, label = '') {
    if (state.points.length >= MAX_POINTS) return toast(`Maximum ${MAX_POINTS} points par parcours`);
    snapshot();
    const p = { id: uid(), lat, lng, label };
    const s = stops();
    let at = state.points.length;
    if (s.length >= 2) {
      let best = Infinity;
      for (let i = 0; i < s.length - 1; i++) {
        const cost = haversine(s[i], p) + haversine(p, s[i + 1]) - haversine(s[i], s[i + 1]);
        if (cost < best) { best = cost; at = i + 1; }
      }
    }
    state.points.splice(at, 0, p);
    if (!label) reverseGeocode(p);
    refresh();
    if (s.length >= 2) toast(`Étape ${at} ajoutée`);
  }
  function setStart(lat, lng) {
    snapshot();
    if (state.points.length) Object.assign(state.points[0], { lat, lng, label: '' });
    else state.points.push({ id: uid(), lat, lng, label: '' });
    reverseGeocode(state.points[0]);
    refresh();
  }
  function removePoint(id) {
    snapshot();
    state.points = state.points.filter(p => p.id !== id);
    refresh();
  }
  function movePoint(id, dir) {
    const i = state.points.findIndex(p => p.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= state.points.length) return;
    snapshot();
    [state.points[i], state.points[j]] = [state.points[j], state.points[i]];
    refresh();
  }
  function reverse() {
    if (state.points.length < 2) return;
    snapshot();
    if (state.loop) state.points = [state.points[0], ...state.points.slice(1).reverse()];
    else state.points.reverse();
    refresh();
  }
  function clearAll() {
    if (!state.points.length) return;
    snapshot();
    state.points = [];
    refresh();
    toast('Parcours effacé. « Annuler » pour revenir en arrière.');
  }

  function refresh() {
    save();
    renderMarkers();
    renderPoints();
    scheduleRoute();
  }

  // ---------- Google Maps : chargement ----------
  const apiKey = () => (CFG.googleMapsApiKey || LS.get('key', '') || '').trim();

  function loadMaps(key) {
    return new Promise((resolve, reject) => {
      window.__haresReady = resolve;
      window.gm_authFailure = () => { reject(new Error('auth')); onAuthFailure(); };
      const s = document.createElement('script');
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
        '&v=weekly&language=fr&loading=async&callback=__haresReady';
      s.async = true;
      s.onerror = () => reject(new Error('network'));
      document.head.appendChild(s);
    });
  }

  function onAuthFailure() {
    $('#map-empty').hidden = false;
    if (!CFG.googleMapsApiKey) LS.del('key');
    openKeyDialog('Google a refusé cette clé. Vérifie qu’elle est correcte, que Maps JavaScript API est activée et que ce site est autorisé.');
  }

  async function initMap() {
    const key = apiKey();
    if (!key) { $('#map-empty').hidden = false; openKeyDialog(); return; }
    try {
      await loadMaps(key);
      if (google.maps.importLibrary) {
        await Promise.all(['maps', 'marker', 'geocoding', 'elevation', 'routes']
          .map(l => google.maps.importLibrary(l).catch(() => null)));
      }
    } catch (e) {
      if (e.message === 'network') { $('#map-empty').hidden = false; toast('Impossible de joindre Google Maps. Vérifie ta connexion.'); }
      return;
    }
    $('#map-empty').hidden = true;

    map = new google.maps.Map($('#map'), {
      center: state.points[0] || CFG.defaultCenter, zoom: CFG.defaultZoom, styles: MAP_STYLE,
      backgroundColor: '#121212', disableDefaultUI: true, zoomControl: true, clickableIcons: false,
      gestureHandling: 'greedy', zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    });
    geocoder = new google.maps.Geocoder();
    map.addListener('click', e => addPoint(e.latLng.lat(), e.latLng.lng()));

    renderMarkers();
    scheduleRoute(true);
    startWatch();
    if (!state.points.length) locate(false);
  }

  // ---------- marqueurs et tracé ----------
  function circleIcon(fill, text, size, textColor = '#fff') {
    const c = size / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<circle cx="${c}" cy="${c}" r="${c - 1.5}" fill="${fill}" stroke="#121212" stroke-width="2"/>` +
      `<text x="${c}" y="${c + 4}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="${size > 24 ? 12 : 10}" fill="${textColor}">${text}</text></svg>`;
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(size, size),
      anchor: new google.maps.Point(c, c),
    };
  }

  function renderMarkers() {
    if (!map) return;
    markers.forEach(m => m.setMap(null));
    markers = state.points.map((p, i) => {
      const m = new google.maps.Marker({
        map, position: { lat: p.lat, lng: p.lng }, draggable: true,
        icon: circleIcon(COLORS[role(i)], badgeText(i), 28),
        title: `${roleLabel(i)}${p.label ? ' — ' + p.label : ''}`, zIndex: role(i) === 'via' ? 10 : 20,
      });
      m.addListener('dragend', e => {
        snapshot();
        p.lat = e.latLng.lat(); p.lng = e.latLng.lng(); p.label = '';
        reverseGeocode(p);
        refresh();
      });
      return m;
    });
  }

  function drawRoute() {
    if (!map) return;
    lines.forEach(l => l.setMap(null));
    lines = [];
    if (!route) return;
    const straight = route.source === 'straight';
    const arrow = {
      icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3, fillColor: '#ffffff', fillOpacity: 1, strokeColor: '#121212', strokeWeight: 1 },
      offset: '40px', repeat: '110px',
    };
    const line = new google.maps.Polyline({
      map, path: route.path, clickable: true, zIndex: 2,
      strokeColor: COLORS.route, strokeOpacity: straight ? 0 : 1, strokeWeight: 5,
      icons: [
        ...(straight ? [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: COLORS.route, strokeWeight: 3, scale: 3 }, offset: '0', repeat: '12px' }] : []),
        arrow,
      ],
    });
    // un clic sur le tracé ajoute une étape dans ce tronçon
    line.addListener('click', e => addPoint(e.latLng.lat(), e.latLng.lng()));
    lines.push(line);
  }

  function fitAll() {
    if (!map) return;
    const pts = route ? route.path : state.points;
    if (!pts.length) { if (myPos) map.panTo(myPos); return; }
    if (pts.length === 1) { map.panTo(pts[0]); map.setZoom(16); return; }
    const b = new google.maps.LatLngBounds();
    pts.forEach(p => b.extend(p));
    const panel = $('#panel');
    map.fitBounds(b, window.innerWidth <= 760
      ? { top: 70, left: 30, right: 30, bottom: panel.offsetHeight + 30 }
      : { top: 60, left: panel.offsetWidth + 40, right: 40, bottom: 40 });
  }

  // ---------- itinéraire ----------
  function scheduleRoute(fitAfter = false) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => computeRoute(fitAfter), 250);
  }

  async function computeRoute(fitAfter) {
    const s = stops();
    const token = ++routeToken;
    if (s.length < 2) {
      route = null; elevation = null;
      drawRoute(); renderStats();
      return;
    }
    $('#busy').hidden = false;
    let r = null;
    if (map) {
      try { r = await routesApi(s); }
      catch (e1) {
        console.warn('Routes API :', e1.message);
        try { r = await directionsApi(s); } catch (e2) { console.warn('DirectionsService :', e2.message); }
      }
    }
    if (!r) r = straightRoute(s);
    if (token !== routeToken) return;
    route = r; elevation = null;
    $('#busy').hidden = true;
    drawRoute(); renderStats();
    if (fitAfter) fitAll();
    if (r.source === 'straight' && map && !warnedStraight) {
      warnedStraight = true;
      toast('Itinéraire piéton indisponible (Routes API non activée ?). Tracé en ligne droite.', 6000);
    }
    fetchElevation(token);
  }

  async function routesApi(s) {
    const wp = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.distanceMeters',
      },
      body: JSON.stringify({
        origin: wp(s[0]), destination: wp(s[s.length - 1]), intermediates: s.slice(1, -1).map(wp),
        travelMode: 'WALK', languageCode: 'fr', units: 'METRIC',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || 'HTTP ' + res.status);
    const r = data.routes?.[0];
    if (!r?.polyline?.encodedPolyline) throw new Error('aucun itinéraire');
    const legs = (r.legs || []).map(l => l.distanceMeters || 0);
    return { path: decodePolyline(r.polyline.encodedPolyline), distance: r.distanceMeters || legs.reduce((a, b) => a + b, 0), legs, source: 'roads' };
  }

  async function directionsApi(s) {
    const res = await new google.maps.DirectionsService().route({
      origin: s[0], destination: s[s.length - 1],
      waypoints: s.slice(1, -1).map(p => ({ location: { lat: p.lat, lng: p.lng }, stopover: true })),
      travelMode: google.maps.TravelMode.WALKING,
    });
    const rt = res.routes[0], path = [];
    rt.legs.forEach(l => l.steps.forEach(st => (st.path || st.lat_lngs || []).forEach(p => path.push(toLit(p)))));
    const legs = rt.legs.map(l => l.distance?.value || 0);
    return { path: path.length ? path : rt.overview_path.map(toLit), distance: legs.reduce((a, b) => a + b, 0), legs, source: 'roads' };
  }

  function straightRoute(s) {
    const legs = [];
    for (let i = 1; i < s.length; i++) legs.push(haversine(s[i - 1], s[i]));
    return { path: s.map(p => ({ lat: p.lat, lng: p.lng })), distance: legs.reduce((a, b) => a + b, 0), legs, source: 'straight' };
  }

  async function fetchElevation(token) {
    if (!map || !route || !google.maps.ElevationService) return;
    try {
      const samples = Math.max(16, Math.min(256, Math.round(route.distance / 40)));
      const res = await new google.maps.ElevationService().getElevationAlongPath({ path: downsample(route.path, 180), samples });
      if (token !== routeToken) return;
      const prof = (res.results || res).map(r => r.elevation).filter(Number.isFinite);
      if (prof.length < 2) return;
      // dénivelé avec hystérésis de 2 m pour ignorer le bruit du modèle de terrain
      let gain = 0, loss = 0, ref = prof[0];
      for (const e of prof) {
        if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) { loss += ref - e; ref = e; }
      }
      elevation = { gain, loss, min: Math.min(...prof), max: Math.max(...prof) };
      renderStats();
    } catch (e) {
      console.warn('Elevation :', e.message);
    }
  }

  // ---------- recherche & adresses ----------
  async function search(q) {
    q = q.trim();
    const box = $('#search-results');
    if (!q) { box.hidden = true; return; }
    if (!map) return toast('Saisis d’abord ta clé Google Maps');
    box.hidden = false;
    box.innerHTML = '<li class="muted">Recherche…</li>';
    let results = [];
    // coordonnées exactes saisies telles quelles : « 5.33641, -4.02670 »
    const m = q.match(/^\s*(-?\d{1,2}(?:[.]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.]\d+)?)\s*$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      results = [{ name: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, address: 'Coordonnées GPS', lat: +m[1], lng: +m[2] }];
    }
    if (!results.length) try { results = await placesSearch(q); } catch (e) { console.warn('Places :', e.message); }
    if (!results.length) { try { results = await geocodeSearch(q); } catch (e) { console.warn('Geocoder :', e.message); } }
    if (!results.length) { box.innerHTML = '<li class="muted">Aucun résultat</li>'; return; }
    box.innerHTML = '';
    results.slice(0, 6).forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="r-main"><b></b><small></small></div><button class="btn r-add" type="button">Ajouter</button>';
      li.querySelector('b').textContent = r.name;
      li.querySelector('small').textContent = r.address || '';
      li.querySelector('.r-main').onclick = () => { map.panTo(r); map.setZoom(16); box.hidden = true; };
      li.querySelector('.r-add').onclick = () => { addPoint(r.lat, r.lng, r.name); map.panTo(r); box.hidden = true; $('#search-input').value = ''; };
      box.appendChild(li);
    });
  }

  async function placesSearch(q) {
    const c = map.getCenter();
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: q, languageCode: 'fr', maxResultCount: 6,
        locationBias: { circle: { center: { latitude: c.lat(), longitude: c.lng() }, radius: 30000 } },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || 'HTTP ' + res.status);
    return (data.places || []).map(p => ({
      name: p.displayName?.text || p.formattedAddress, address: p.formattedAddress,
      lat: p.location.latitude, lng: p.location.longitude,
    }));
  }

  async function geocodeSearch(q) {
    const { results } = await geocoder.geocode({ address: q, bounds: map.getBounds() || undefined });
    return results.map(r => {
      const parts = r.formatted_address.split(',');
      return { name: parts[0], address: parts.slice(1).join(',').trim(), ...toLit(r.geometry.location) };
    });
  }

  async function reverseGeocode(p) {
    const fallback = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
    if (!geocoder) { p.label = p.label || fallback; return; }
    try {
      const { results } = await geocoder.geocode({ location: { lat: p.lat, lng: p.lng } });
      const best = results.find(r => !r.types.includes('plus_code')) || results[0];
      p.label = best ? best.formatted_address.split(',').slice(0, 2).join(',').trim() : fallback;
    } catch {
      p.label = fallback;
    }
    if (state.points.includes(p)) { save(); renderPoints(); renderMarkers(); }
  }

  // ---------- géolocalisation ----------
  function showMe() {
    if (!map || !myPos) return;
    if (!meOverlay) {
      class Me extends google.maps.OverlayView {
        constructor() { super(); this.pos = null; this.div = document.createElement('div'); this.div.className = 'me-dot'; }
        onAdd() { this.getPanes().overlayLayer.appendChild(this.div); }
        draw() {
          const proj = this.getProjection();
          if (!proj || !this.pos) return;
          const px = proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pos.lat, this.pos.lng));
          if (px) { this.div.style.left = px.x + 'px'; this.div.style.top = px.y + 'px'; }
        }
        onRemove() { this.div.remove(); }
        set(pos) { this.pos = pos; this.draw(); }
      }
      meOverlay = new Me();
      meOverlay.setMap(map);
    }
    meOverlay.set(myPos);
    // cercle de précision : la position réelle est quelque part dedans
    if (!accCircle) {
      accCircle = new google.maps.Circle({
        map, clickable: false, zIndex: 1, strokeColor: '#3b82f6', strokeOpacity: 0.6, strokeWeight: 1,
        fillColor: '#3b82f6', fillOpacity: 0.12,
      });
    }
    accCircle.setCenter(myPos);
    accCircle.setRadius(myPos.acc || 0);
  }
  function setMyPos(pos) {
    myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    showMe();
    const el = $('#gps');
    el.hidden = false;
    el.textContent = `Ta position : ${myPos.lat.toFixed(5)}, ${myPos.lng.toFixed(5)} (précision ±${Math.round(myPos.acc)} m)`;
  }
  // le suivi continu alimente aussi les recherches de position précise en cours
  const fixListeners = new Set();
  let lastFix = null;
  function onFix(pos) {
    lastFix = { pos, time: Date.now() };
    fixListeners.forEach(f => f(pos));
    if (!locating) setMyPos(pos);
  }
  function startWatch() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }

  /**
   * Position la plus précise possible : le GPS s'affine pendant quelques
   * secondes. On écoute jusqu'à passer sous `target` mètres de marge, ou
   * jusqu'à `maxWait`, et on garde la meilleure mesure reçue.
   */
  function bestPosition(target = 10, maxWait = 12000) {
    return new Promise((resolve, reject) => {
      let best = null, id = null, timer = null;
      const finish = err => {
        if (id != null) navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        fixListeners.delete(consider);
        if (err) reject(err); else if (best) resolve(best); else reject({ code: 3 });
      };
      function consider(pos) {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        setMyPos(best);
        toast(`Localisation… précision ±${Math.round(best.coords.accuracy)} m`, maxWait);
        if (best.coords.accuracy <= target) finish();
      }
      fixListeners.add(consider);
      timer = setTimeout(() => finish(), maxWait);
      id = navigator.geolocation.watchPosition(
        consider,
        err => { if (err.code === 1) finish(err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: maxWait }
      );
      // une mesure toute récente du suivi continu sert de point de départ
      if (lastFix && Date.now() - lastFix.time < 10000) consider(lastFix.pos);
    });
  }

  async function locate(asStart) {
    if (!navigator.geolocation) return toast('Cet appareil ne fournit pas sa position');
    if (locating) return;
    locating = true;
    toast('Localisation en cours…', 12000);
    try {
      const pos = await bestPosition();
      setMyPos(pos);
      if (map) { map.panTo(myPos); if (map.getZoom() < 17) map.setZoom(17); }
      const acc = Math.round(myPos.acc);
      if (asStart) setStart(myPos.lat, myPos.lng);
      toast(`${asStart ? 'Départ placé sur ta position' : 'Position trouvée'} (précision ±${acc} m)` +
        (acc > 50 ? '. Active le GPS ou sors à découvert pour plus de précision.' : ''), 5000);
    } catch (err) {
      toast(err.code === 1 ? 'Localisation refusée. Autorise-la dans le navigateur, ou clique sur la carte.'
        : 'Position introuvable pour le moment. Clique sur la carte.', 5000);
    } finally {
      locating = false;
    }
  }

  // ---------- rendu du panneau ----------
  function renderPoints() {
    const ol = $('#points');
    ol.innerHTML = '';
    const n = state.points.length;
    $('#hint').textContent = n === 0 ? 'Clique sur la carte pour placer le départ.'
      : n === 1 ? (state.loop ? 'Clique sur la carte pour ajouter des étapes : la boucle revient au départ.' : 'Clique sur la carte pour placer l’arrivée.')
        : 'Clique sur la carte ou sur le tracé pour ajouter une étape. Fais glisser les repères pour les déplacer.';
    const legs = route && route.legs.length === stops().length - 1 ? route.legs : null;
    state.points.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = `pt pt--${role(i)}`;
      li.innerHTML = `<button class="pt__badge" type="button" title="Centrer la carte"></button>
        <div class="pt__body"><small></small><input class="pt__name" type="text" maxlength="60" placeholder="Localisation…"></div>
        <div class="pt__acts">
          <button type="button" data-m="-1" title="Monter">↑</button>
          <button type="button" data-m="1" title="Descendre">↓</button>
          <button type="button" data-del title="Supprimer">×</button>
        </div>`;
      li.querySelector('.pt__badge').textContent = badgeText(i);
      li.querySelector('small').textContent = roleLabel(i);
      if (legs && i > 0) li.querySelector('small').insertAdjacentHTML('beforeend', `<span class="leg">· ${nf2.format(legs[i - 1] / 1000)} km</span>`);
      const input = li.querySelector('.pt__name');
      input.value = p.label || '';
      input.addEventListener('change', () => { p.label = input.value.trim(); save(); renderMarkers(); });
      li.querySelector('.pt__badge').onclick = () => map && map.panTo(p);
      li.querySelector('.pt__badge').title = `Centrer la carte — ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      li.querySelector('[data-m="-1"]').disabled = i === 0;
      li.querySelector('[data-m="1"]').disabled = i === n - 1;
      li.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => movePoint(p.id, +b.dataset.m)));
      li.querySelector('[data-del]').onclick = () => removePoint(p.id);
      ol.appendChild(li);
    });
    if (state.loop && legs) {
      const li = document.createElement('li');
      li.className = 'pt muted small';
      li.textContent = `Retour au départ · ${nf2.format(legs[legs.length - 1] / 1000)} km`;
      ol.appendChild(li);
    }
  }

  function renderStats() {
    const d = km();
    $('#st-dist').textContent = nf2.format(d);
    $('#st-stops').textContent = Math.max(0, state.points.length - (state.loop ? 1 : 2));
    $('#st-gain').textContent = elevation ? `${Math.round(elevation.gain)} m` : '—';
    $('#st-source').hidden = !route || route.source !== 'straight';
    $('#st-source').textContent = 'Distance à vol d’oiseau (itinéraire piéton indisponible).';
    renderPoints();
    updatePace();
  }

  // ---------- allure ----------
  const timeInputs = ['#t-h', '#t-m', '#t-s'].map($);
  const paceInputs = ['#p-m', '#p-s'].map($);
  const readNum = el => Math.max(0, parseInt(el.value, 10) || 0);

  function updatePace() {
    const d = km();
    if (d > 0) {
      if (state.lastEdited === 'time' && state.targetSec) state.paceSec = state.targetSec / d;
      else if (state.lastEdited === 'pace' && state.paceSec) state.targetSec = state.paceSec * d;
    }
    save();
    const active = document.activeElement;
    if (!timeInputs.includes(active)) {
      const t = state.targetSec ? Math.round(state.targetSec) : 0;
      timeInputs[0].value = t ? Math.floor(t / 3600) : '';
      timeInputs[1].value = t ? pad(Math.floor(t % 3600 / 60)) : '';
      timeInputs[2].value = t ? pad(t % 60) : '';
    }
    if (!paceInputs.includes(active)) {
      const p = state.paceSec ? Math.round(state.paceSec) : 0;
      paceInputs[0].value = p ? Math.floor(p / 60) : '';
      paceInputs[1].value = p ? pad(p % 60) : '';
    }
    const pace = state.paceSec, total = d > 0 ? state.targetSec : null;
    $('#speed').textContent = pace ? nf1.format(3600 / pace) + ' km/h' : '—';
    $('#half').textContent = total ? fmtDur(total / 2) : '—';
    $('#eta').textContent = total ? new Date(Date.now() + total * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
    $('#summary').textContent = `${nf2.format(d)} km` + (pace ? ` · ${fmtPace(pace)} /km` : '');

    const tbl = $('#splits');
    tbl.innerHTML = '';
    if (pace && d > 0) {
      const full = Math.floor(d);
      for (let i = 1; i <= Math.min(full, 200); i++) tbl.insertAdjacentHTML('beforeend', `<tr><th>km ${i}</th><td>${fmtDur(i * pace)}</td></tr>`);
      if (d - full > 0.01) tbl.insertAdjacentHTML('beforeend', `<tr><th>Arrivée (${nf2.format(d)} km)</th><td>${fmtDur(d * pace)}</td></tr>`);
    } else {
      tbl.innerHTML = '<tr><th>Trace un parcours et indique un temps ou une allure.</th></tr>';
    }
  }

  timeInputs.forEach(el => el.addEventListener('input', () => {
    const t = readNum(timeInputs[0]) * 3600 + readNum(timeInputs[1]) * 60 + readNum(timeInputs[2]);
    state.targetSec = t || null;
    state.lastEdited = 'time';
    if (!t) state.paceSec = null;
    updatePace();
  }));
  paceInputs.forEach(el => el.addEventListener('input', () => {
    const p = readNum(paceInputs[0]) * 60 + readNum(paceInputs[1]);
    state.paceSec = p || null;
    state.lastEdited = 'pace';
    if (!p) state.targetSec = null;
    updatePace();
  }));
  [...timeInputs, ...paceInputs].forEach(el => el.addEventListener('blur', () => setTimeout(updatePace)));

  // ---------- export PNG ----------
  const defaultName = () => 'Run du ' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';

  function posterData() {
    return {
      name: state.name.trim() || defaultName(),
      date: new Date(),
      path: route ? route.path : [],
      distance: route ? route.distance : 0,
      straight: route?.source === 'straight',
      loop: state.loop,
      points: state.points.map((p, i) => ({ lat: p.lat, lng: p.lng, label: p.label, role: role(i), badge: badgeText(i) })),
      targetSec: state.targetSec,
      paceSec: state.paceSec,
      elevation,
    };
  }

  async function renderPoster() {
    const res = await window.HaresPoster.render($('#poster'), posterData(), {
      colors: COLORS, withMap: state.withMap && !!apiKey(), apiKey: apiKey(),
    });
    $('#export-note').textContent = state.withMap && !res.mapUsed
      ? 'Fond de carte indisponible (Maps Static API non activée ?). Version sans carte.' : '';
  }

  function openExport() {
    if (!route) return toast('Place au moins un départ et une arrivée.');
    $('#with-map').checked = state.withMap;
    $('#export-dialog').showModal();
    renderPoster();
  }

  function downloadPng() {
    $('#poster').toBlob(blob => {
      if (!blob) return toast('Export impossible.');
      const d = posterData();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `hares-run-${slug(d.name)}-${(d.distance / 1000).toFixed(1)}km.png` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  // ---------- divers ----------
  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }
  function openKeyDialog(error) {
    const d = $('#key-dialog');
    $('#key-input').value = LS.get('key', '') || CFG.googleMapsApiKey || '';
    $('#key-error').hidden = !error;
    $('#key-error').textContent = error || '';
    if (!d.open) d.showModal();
  }

  function bindUI() {
    $('#run-name').value = state.name;
    $('#run-name').addEventListener('input', e => { state.name = e.target.value; save(); });
    $('#loop').checked = state.loop;
    $('#loop').addEventListener('change', e => { snapshot(); state.loop = e.target.checked; refresh(); });

    $('#search').addEventListener('submit', e => { e.preventDefault(); search($('#search-input').value); });
    $('#search-input').addEventListener('input', e => { if (!e.target.value) $('#search-results').hidden = true; });

    $('#key-form').addEventListener('submit', () => {
      const k = $('#key-input').value.trim();
      if (!k) return;
      LS.set('key', k);
      location.reload();
    });
    $('#with-map').addEventListener('change', e => { state.withMap = e.target.checked; save(); renderPoster(); });

    const actions = {
      'open-key': () => openKeyDialog(),
      'forget-key': () => { LS.del('key'); $('#key-input').value = ''; toast('Clé oubliée'); },
      locate: () => locate(false),
      'start-here': () => locate(true),
      fit: fitAll, undo, clear: clearAll, reverse,
      'toggle-sheet': () => $('#panel').classList.toggle('is-collapsed'),
      'open-export': openExport,
      'close-export': () => $('#export-dialog').close(),
      download: downloadPng,
    };
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](); }
    });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    });
  }

  // ---------- démarrage ----------
  bindUI();
  renderStats();
  initMap();

  window.HaresRun = { state, get route() { return route; }, addPoint, fitAll };
})();
