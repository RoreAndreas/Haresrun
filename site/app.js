/*
 * HARES RUN — planificateur de runs sur OpenStreetMap.
 *
 * Un parcours = une liste de points : le premier est le départ, le dernier
 * l'arrivée, ceux du milieu des étapes. En mode « Boucle », l'arrivée revient
 * au départ et tous les points ajoutés sont des étapes.
 *
 * Services gratuits, sans clé :
 *   carte       Leaflet + tuiles OpenStreetMap (complète), Esri (simplifiée, satellite)
 *   itinéraire  OSRM piéton de FOSSGIS (routing.openstreetmap.de), ligne droite en secours
 *   recherche   Nominatim (OpenStreetMap), Photon en secours
 *   altitude    Open-Meteo
 */
(() => {
  'use strict';

  const CFG = Object.assign(
    { defaultCenter: { lat: 5.3364, lng: -4.0267 }, defaultZoom: 14 },
    window.HARES_CONFIG || {}
  );
  const COLORS = { route: '#ff7a1a', start: '#3fa34d', via: '#6b6b6b', finish: '#d64545' };
  const MAX_POINTS = 50;
  const OSM_COPY = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  // Fonds de carte gratuits et sans clé.
  //   simple    fond gris foncé épuré d'Esri (rues principales, noms) — maxNative 16
  //   dark      carte OpenStreetMap complète, inversée à l'affichage
  //   light     la même en couleurs d'origine
  //   satellite imagerie Esri
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const LAYERS = {
    simple: {
      url: ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      overlay: ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19, maxNative: 16,
      attribution: 'Fond &copy; Esri, HERE, Garmin, ' + OSM_COPY, credit: '© Esri, HERE, Garmin, OpenStreetMap',
    },
    dark: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, maxNative: 19, invert: true,
      attribution: OSM_COPY, credit: '© OpenStreetMap',
    },
    light: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, maxNative: 19,
      attribution: OSM_COPY, credit: '© OpenStreetMap',
    },
    satellite: {
      url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', maxZoom: 19, maxNative: 19,
      attribution: 'Imagerie &copy; Esri, Maxar, Earthstar Geographics', credit: 'Imagerie © Esri, Maxar',
    },
  };
  const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/';
  const PHOTON = 'https://photon.komoot.io/api/';
  const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

  // ---------- stockage local ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('haresrun.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('haresrun.' + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  };

  // ---------- état ----------
  const saved = LS.get('state', {});
  const state = {
    points: Array.isArray(saved.points) ? saved.points.filter(p => p && isFinite(p.lat) && isFinite(p.lng)) : [],
    loop: !!saved.loop,
    follow: saved.follow !== false,
    layer: LAYERS[saved.layer] ? saved.layer : 'dark',
    name: typeof saved.name === 'string' ? saved.name : '',
    targetSec: saved.targetSec > 0 ? saved.targetSec : null,
    paceSec: saved.paceSec > 0 ? saved.paceSec : null,
    lastEdited: saved.lastEdited === 'pace' ? 'pace' : 'time',
    withMap: saved.withMap !== false,
  };
  let route = null;      // { path:[{lat,lng}], distance, legs:[m], source }
  let elevation = null;  // { gain, loss, min, max }
  let map = null, tiles = null, myPos = null, meDot = null, accCircle = null;
  let pinLayer = null, routeLayer = null, arrowLayer = null;
  let routeToken = 0, routeTimer = null, warnedStraight = false, locating = false;
  const history = [];

  const $ = s => document.querySelector(s);
  const uid = () => Math.random().toString(36).slice(2, 9);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const save = () => LS.set('state', state);

  async function getJSON(url, timeout = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

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
  /** `n` points régulièrement espacés le long du tracé (pour les altitudes). */
  function resample(path, n) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversine(path[i - 1], path[i]));
    const total = cum[cum.length - 1], out = [];
    let j = 1;
    for (let k = 0; k < n; k++) {
      const d = total * k / (n - 1);
      while (j < path.length - 1 && cum[j] < d) j++;
      const seg = cum[j] - cum[j - 1], t = seg ? (d - cum[j - 1]) / seg : 0;
      out.push({ lat: path[j - 1].lat + (path[j].lat - path[j - 1].lat) * t, lng: path[j - 1].lng + (path[j].lng - path[j - 1].lng) * t });
    }
    return out;
  }

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

  // ---------- carte ----------
  function initMap() {
    if (!window.L) { $('#map-empty').hidden = false; return; }
    map = L.map('map', { zoomControl: false, worldCopyJump: true })
      .setView(state.points[0] || CFG.defaultCenter, CFG.defaultZoom);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    routeLayer = L.layerGroup().addTo(map);
    arrowLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    setLayer(state.layer);

    map.on('click', e => addPoint(e.latlng.lat, e.latlng.lng));
    map.on('zoomend moveend', () => { drawArrows(); updateEditLink(); });

    renderMarkers();
    scheduleRoute(state.points.length > 1);
    startWatch();
    if (!state.points.length) locate(false, true);
    updateEditLink();
  }

  function setLayer(id) {
    state.layer = LAYERS[id] ? id : 'dark';
    save();
    $('#layer').value = state.layer;
    const l = LAYERS[state.layer];
    if (tiles) tiles.remove();
    const opts = { subdomains: l.subdomains || 'abc', maxZoom: l.maxZoom, maxNativeZoom: l.maxNative, crossOrigin: true };
    tiles = L.layerGroup([L.tileLayer(l.url, { ...opts, attribution: l.attribution })]);
    if (l.overlay) tiles.addLayer(L.tileLayer(l.overlay, opts));
    tiles.addTo(map);
    document.body.classList.toggle('layer-invert', !!l.invert);
  }

  function updateEditLink() {
    if (!map) return;
    const c = map.getCenter();
    $('#osm-edit').href = `https://www.openstreetmap.org/edit#map=${Math.max(16, map.getZoom())}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`;
  }

  function pinIcon(i) {
    return L.divIcon({
      className: '', iconSize: [28, 28], iconAnchor: [14, 14],
      html: `<div class="pin pin--${role(i)}">${badgeText(i)}</div>`,
    });
  }

  function renderMarkers() {
    if (!map) return;
    pinLayer.clearLayers();
    state.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], {
        icon: pinIcon(i), draggable: true, autoPan: true, keyboard: false,
        title: `${roleLabel(i)}${p.label ? ' — ' + p.label : ''}`,
        zIndexOffset: role(i) === 'via' ? 0 : 1000,
      }).addTo(pinLayer);
      m.on('dragend', () => {
        snapshot();
        const ll = m.getLatLng();
        p.lat = ll.lat; p.lng = ll.lng; p.label = '';
        reverseGeocode(p);
        refresh();
      });
    });
    drawArrows();
  }

  function drawRoute() {
    if (!map) return;
    routeLayer.clearLayers();
    if (route) {
      const straight = route.source === 'straight';
      L.polyline(route.path, { color: '#121212', weight: 9, opacity: 0.6, interactive: false }).addTo(routeLayer);
      const line = L.polyline(route.path, {
        color: COLORS.route, weight: 5, opacity: 1, dashArray: straight ? '10 8' : null, className: 'route-line',
      }).addTo(routeLayer);
      // un clic sur le tracé ajoute une étape dans ce tronçon
      line.on('click', e => { L.DomEvent.stopPropagation(e); addPoint(e.latlng.lat, e.latlng.lng); });
    }
    drawArrows();
  }

  /** Flèches de sens tous les ~110 px à l'écran, recalculées à chaque zoom. */
  function drawArrows() {
    if (!map || !arrowLayer) return;
    arrowLayer.clearLayers();
    if (!route || route.path.length < 2) return;
    const view = map.getBounds().pad(0.2);
    const pins = state.points.map(p => map.latLngToLayerPoint([p.lat, p.lng]));
    const pts = route.path.map(p => map.latLngToLayerPoint([p.lat, p.lng]));
    const every = 110;
    let acc = 0, next = every / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], seg = a.distanceTo(b);
      while (seg > 0 && acc + seg >= next) {
        const t = (next - acc) / seg;
        const pt = L.point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        next += every;
        if (pins.some(q => q.distanceTo(pt) < 26)) continue;
        const ll = map.layerPointToLatLng(pt);
        if (!view.contains(ll)) continue;
        const deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        L.marker(ll, {
          interactive: false, keyboard: false,
          icon: L.divIcon({
            className: 'arrow', iconSize: [16, 16], iconAnchor: [8, 8],
            html: `<svg width="16" height="16" viewBox="-8 -8 16 16" style="transform:rotate(${deg.toFixed(1)}deg)"><path d="M7 0L-5-6-2 0-5 6Z" fill="#fff" stroke="#121212" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
          }),
        }).addTo(arrowLayer);
      }
      acc += seg;
    }
  }

  function fitAll() {
    if (!map) return;
    const pts = route ? route.path : state.points;
    if (!pts.length) { if (myPos) map.setView(myPos, Math.max(map.getZoom(), 16)); return; }
    if (pts.length === 1) { map.setView(pts[0], 16); return; }
    const panel = $('#panel');
    const mobile = window.innerWidth <= 760;
    map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])), mobile
      ? { paddingTopLeft: [30, 70], paddingBottomRight: [30, panel.offsetHeight + 30] }
      : { paddingTopLeft: [panel.offsetWidth + 40, 60], paddingBottomRight: [60, 40] });
  }

  // ---------- itinéraire ----------
  function scheduleRoute(fitAfter = false) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => computeRoute(fitAfter), 300);
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
    if (state.follow) {
      try { r = await osrmRoute(s); } catch (e) { console.warn('Itinéraire :', e.message); }
    }
    if (token !== routeToken) return;
    const failed = state.follow && !r;
    if (!r) r = straightRoute(s);
    route = r; elevation = null;
    $('#busy').hidden = true;
    drawRoute(); renderStats();
    if (fitAfter) fitAll();
    if (failed && !warnedStraight) {
      warnedStraight = true;
      toast('Service d’itinéraire indisponible pour le moment : tracé en ligne droite.', 6000);
    }
    fetchElevation(token);
  }

  async function osrmRoute(s) {
    const coords = s.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const data = await getJSON(`${ROUTER}${coords}?overview=full&geometries=polyline&steps=false`);
    const r = data.routes && data.routes[0];
    if (data.code !== 'Ok' || !r) throw new Error(data.message || data.code || 'aucun itinéraire');
    return { path: decodePolyline(r.geometry), distance: r.distance, legs: r.legs.map(l => l.distance), source: 'roads' };
  }

  function straightRoute(s) {
    const legs = [];
    for (let i = 1; i < s.length; i++) legs.push(haversine(s[i - 1], s[i]));
    return { path: s.map(p => ({ lat: p.lat, lng: p.lng })), distance: legs.reduce((a, b) => a + b, 0), legs, source: 'straight' };
  }

  async function fetchElevation(token) {
    if (!route) return;
    try {
      const n = Math.max(10, Math.min(100, Math.round(route.distance / 50)));
      const pts = resample(route.path, n);
      const data = await getJSON(`${ELEVATION}?latitude=${pts.map(p => p.lat.toFixed(5)).join(',')}&longitude=${pts.map(p => p.lng.toFixed(5)).join(',')}`);
      if (token !== routeToken) return;
      const prof = (data.elevation || []).filter(Number.isFinite);
      if (prof.length < 2) return;
      // dénivelé avec hystérésis de 2 m pour ignorer le bruit du modèle de terrain
      let gain = 0, loss = 0, ref = prof[0];
      for (const e of prof) {
        if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) { loss += ref - e; ref = e; }
      }
      elevation = { gain, loss, min: Math.min(...prof), max: Math.max(...prof) };
      renderStats();
    } catch (e) {
      console.warn('Altitude :', e.message);
    }
  }

  // ---------- recherche & adresses ----------
  async function search(q) {
    q = q.trim();
    const box = $('#search-results');
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<li class="muted">Recherche…</li>';
    let results = [];
    // coordonnées exactes saisies telles quelles : « 5.33641, -4.02670 »
    const m = q.match(/^\s*(-?\d{1,2}(?:[.]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.]\d+)?)\s*$/);
    if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) {
      results = [{ name: `${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, address: 'Coordonnées GPS', lat: +m[1], lng: +m[2] }];
    }
    if (!results.length) try { results = await nominatimSearch(q); } catch (e) { console.warn('Nominatim :', e.message); }
    if (!results.length) try { results = await photonSearch(q); } catch (e) { console.warn('Photon :', e.message); }
    if (!results.length) { box.innerHTML = '<li class="muted">Aucun résultat</li>'; return; }
    box.innerHTML = '';
    results.slice(0, 6).forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="r-main"><b></b><small></small></div><button class="btn r-add" type="button">Ajouter</button>';
      li.querySelector('b').textContent = r.name;
      li.querySelector('small').textContent = r.address || '';
      li.querySelector('.r-main').onclick = () => { map && map.setView(r, 16); box.hidden = true; };
      li.querySelector('.r-add').onclick = () => { addPoint(r.lat, r.lng, r.name); map && map.panTo(r); box.hidden = true; $('#search-input').value = ''; };
      box.appendChild(li);
    });
  }

  async function nominatimSearch(q) {
    let url = `${NOMINATIM}search?format=jsonv2&limit=6&accept-language=fr&q=${encodeURIComponent(q)}`;
    if (map) { const b = map.getBounds().pad(2); url += `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`; }
    const data = await getJSON(url);
    return data.map(r => {
      const parts = r.display_name.split(',').map(s => s.trim());
      return { name: r.name || parts[0], address: parts.slice(1, 4).join(', '), lat: +r.lat, lng: +r.lon };
    });
  }

  async function photonSearch(q) {
    let url = `${PHOTON}?limit=6&lang=fr&q=${encodeURIComponent(q)}`;
    if (map) { const c = map.getCenter(); url += `&lat=${c.lat}&lon=${c.lng}`; }
    const data = await getJSON(url);
    return (data.features || []).map(f => {
      const p = f.properties;
      return {
        name: p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city,
        address: [p.street, p.district, p.city, p.country].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      };
    });
  }

  // Nominatim demande au plus une requête par seconde : les noms de points
  // passent par une file d'attente.
  const geoQueue = [];
  let geoBusy = false;
  function reverseGeocode(p) {
    if (!geoQueue.includes(p)) geoQueue.push(p);
    pumpGeo();
  }
  async function pumpGeo() {
    if (geoBusy) return;
    geoBusy = true;
    while (geoQueue.length) {
      const p = geoQueue.shift();
      if (!state.points.includes(p) || p.label) continue;
      const lat = p.lat, lng = p.lng;
      let label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      try {
        const d = await getJSON(`${NOMINATIM}reverse?format=jsonv2&accept-language=fr&zoom=17&lat=${lat}&lon=${lng}`, 10000);
        const a = d.address || {};
        const road = [a.house_number, a.road || a.pedestrian || a.footway || a.path || a.park].filter(Boolean).join(' ');
        const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.city || a.town || a.village;
        label = [road, area].filter(Boolean).join(', ') || (d.display_name || '').split(',').slice(0, 2).join(',').trim() || label;
      } catch (e) {
        console.warn('Adresse :', e.message);
      }
      // le point a pu être déplacé ou renommé pendant la requête
      if (state.points.includes(p) && !p.label && p.lat === lat && p.lng === lng) {
        p.label = label;
        save(); renderPoints(); renderMarkers();
      }
      await sleep(1100);
    }
    geoBusy = false;
  }

  // ---------- géolocalisation ----------
  function showMe() {
    if (!map || !myPos) return;
    if (!meDot) {
      accCircle = L.circle(myPos, { radius: 0, color: '#3b82f6', weight: 1, opacity: 0.6, fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false }).addTo(map);
      meDot = L.circleMarker(myPos, { radius: 7, color: '#ffffff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1, interactive: false }).addTo(map);
    }
    meDot.setLatLng(myPos);
    accCircle.setLatLng(myPos).setRadius(myPos.acc || 0);
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
  function bestPosition(target = 10, maxWait = 12000, quiet = false) {
    return new Promise((resolve, reject) => {
      let best = null, id = null, timer = null, lastErr = null;
      const finish = err => {
        if (id != null) navigator.geolocation.clearWatch(id);
        clearTimeout(timer);
        fixListeners.delete(consider);
        if (best) return resolve(best);
        if (err) return reject(err);
        // rien en haute précision (ordinateur sans GPS, service de localisation
        // lent…) : dernière chance en précision normale, position récente acceptée
        navigator.geolocation.getCurrentPosition(resolve, e => reject(e || lastErr || { code: 3 }),
          { enableHighAccuracy: false, maximumAge: 300000, timeout: 10000 });
      };
      function consider(pos) {
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        setMyPos(best);
        if (!quiet) toast(`Localisation… précision ±${Math.round(best.coords.accuracy)} m`, maxWait);
        if (best.coords.accuracy <= target) finish();
      }
      fixListeners.add(consider);
      timer = setTimeout(() => finish(), maxWait);
      id = navigator.geolocation.watchPosition(
        consider,
        err => { lastErr = err; if (err.code === 1) finish(err); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: maxWait }
      );
      // une mesure toute récente du suivi continu sert de point de départ
      if (lastFix && Date.now() - lastFix.time < 10000) consider(lastFix.pos);
    });
  }

  function geoErrorText(err) {
    if (!window.isSecureContext) return 'La localisation exige une adresse en https:// (ou localhost).';
    if (err.code === 1) return 'Localisation refusée : autorise-la pour ce site (icône à gauche de l’adresse), puis réessaie.';
    if (err.code === 2) return 'Position indisponible : active la localisation de l’appareil (sur Windows : Paramètres → Confidentialité → Localisation), puis réessaie.';
    return 'La position met trop de temps à arriver. Réessaie, ou clique sur la carte.';
  }

  // Une demande explicite (bouton) remplace celle, silencieuse, du démarrage.
  let locateRun = 0;
  async function locate(asStart, quiet = false) {
    if (!navigator.geolocation) return quiet || toast('Cet appareil ne fournit pas sa position');
    const run = ++locateRun;
    locating = true;
    if (!quiet) toast('Localisation en cours…', 25000);
    try {
      const pos = await bestPosition(10, quiet ? 6000 : 12000, quiet);
      if (run !== locateRun) return;
      setMyPos(pos);
      if (map) map.setView(myPos, Math.max(map.getZoom(), quiet ? 15 : 17));
      if (asStart) setStart(myPos.lat, myPos.lng);
      if (!quiet) {
        const acc = Math.round(myPos.acc);
        toast(`${asStart ? 'Départ placé sur ta position' : 'Position trouvée'} (précision ±${acc} m)` +
          (acc > 50 ? '. Active le GPS ou mets-toi à découvert pour plus de précision.' : ''), 5000);
      }
    } catch (err) {
      if (run !== locateRun) return;
      console.warn('Localisation :', err.code, err.message);
      if (!quiet || err.code === 1) toast(geoErrorText(err), 8000);
    } finally {
      if (run === locateRun) locating = false;
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
      li.innerHTML = `<button class="pt__badge" type="button"></button>
        <div class="pt__body"><small></small><input class="pt__name" type="text" maxlength="60" placeholder="Localisation…"></div>
        <div class="pt__acts">
          <button type="button" data-m="-1" title="Monter">↑</button>
          <button type="button" data-m="1" title="Descendre">↓</button>
          <button type="button" data-del title="Supprimer">×</button>
        </div>`;
      const badge = li.querySelector('.pt__badge');
      badge.textContent = badgeText(i);
      badge.title = `Centrer la carte — ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
      badge.onclick = () => map && map.panTo([p.lat, p.lng]);
      li.querySelector('small').textContent = roleLabel(i);
      if (legs && i > 0) li.querySelector('small').insertAdjacentHTML('beforeend', `<span class="leg">· ${nf2.format(legs[i - 1] / 1000)} km</span>`);
      const input = li.querySelector('.pt__name');
      input.value = p.label || '';
      input.addEventListener('change', () => { p.label = input.value.trim(); save(); renderMarkers(); });
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
    $('#st-source').textContent = state.follow ? 'Distance à vol d’oiseau (itinéraire indisponible).' : 'Tracé libre : distance à vol d’oiseau entre les points.';
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
      colors: COLORS, withMap: state.withMap, layer: LAYERS[state.layer],
    });
    $('#export-note').textContent = state.withMap && !res.mapUsed
      ? 'Fond de carte indisponible pour le moment : version sans carte.' : '';
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

  function bindUI() {
    $('#run-name').value = state.name;
    $('#run-name').addEventListener('input', e => { state.name = e.target.value; save(); });
    $('#loop').checked = state.loop;
    $('#loop').addEventListener('change', e => { snapshot(); state.loop = e.target.checked; refresh(); });
    $('#follow').checked = state.follow;
    $('#follow').addEventListener('change', e => { state.follow = e.target.checked; warnedStraight = false; save(); scheduleRoute(); });
    $('#layer').addEventListener('change', e => setLayer(e.target.value));

    $('#search').addEventListener('submit', e => { e.preventDefault(); search($('#search-input').value); });
    $('#search-input').addEventListener('input', e => { if (!e.target.value) $('#search-results').hidden = true; });
    $('#with-map').addEventListener('change', e => { state.withMap = e.target.checked; save(); renderPoster(); });

    const actions = {
      locate: () => locate(false),
      'start-here': () => locate(true),
      fit: fitAll, undo, clear: clearAll, reverse,
      'toggle-sheet': () => {
        const c = $('#panel').classList.toggle('is-collapsed');
        document.body.classList.toggle('sheet-collapsed', c);
      },
      'open-export': openExport,
      'close-export': () => $('#export-dialog').close(),
      download: downloadPng,
    };
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (el && actions[el.dataset.action]) { e.preventDefault(); actions[el.dataset.action](); }
    });
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); }
    });
  }

  // ---------- démarrage ----------
  bindUI();
  renderStats();
  initMap();

  window.HaresRun = { state, get route() { return route; }, get map() { return map; }, addPoint, fitAll };
})();
