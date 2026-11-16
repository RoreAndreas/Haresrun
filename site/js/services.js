/*
 * Services en ligne gratuits et sans clé :
 *   itinéraire piéton  OSRM de FOSSGIS (routing.openstreetmap.de)
 *   altitudes          Open-Meteo
 *   recherche, adresse Nominatim (OpenStreetMap), Photon en secours
 */
(() => {
  'use strict';
  const { getJSON, decodePolyline, dist, resample, sleep } = HR;

  const ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/';
  const PHOTON = 'https://photon.komoot.io/api/';
  const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

  /** Itinéraire piéton passant par les points `s` dans l'ordre. */
  async function route(s) {
    const coords = s.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const data = await getJSON(`${ROUTER}${coords}?overview=full&geometries=polyline&steps=false`);
    const r = data.routes && data.routes[0];
    if (data.code !== 'Ok' || !r) throw new Error(data.message || data.code || 'aucun itinéraire');
    return { path: decodePolyline(r.geometry), distance: r.distance, legs: r.legs.map(l => l.distance), source: 'roads' };
  }

  function straight(s) {
    const legs = [];
    for (let i = 1; i < s.length; i++) legs.push(dist(s[i - 1], s[i]));
    return { path: s.map(p => ({ lat: p.lat, lng: p.lng })), distance: legs.reduce((a, b) => a + b, 0), legs, source: 'straight' };
  }

  /** Dénivelés positif et négatif (hystérésis de 2 m contre le bruit du terrain). */
  async function elevation(path, distance) {
    const n = Math.max(10, Math.min(100, Math.round(distance / 50)));
    const pts = resample(path, n);
    const data = await getJSON(`${ELEVATION}?latitude=${pts.map(p => p.lat.toFixed(5)).join(',')}&longitude=${pts.map(p => p.lng.toFixed(5)).join(',')}`);
    const prof = (data.elevation || []).filter(Number.isFinite);
    if (prof.length < 2) return null;
    let gain = 0, loss = 0, ref = prof[0];
    for (const e of prof) {
      if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) { loss += ref - e; ref = e; }
    }
    return { gain, loss };
  }

  async function search(q, near) {
    let url = `${NOMINATIM}search?format=jsonv2&limit=6&accept-language=fr&q=${encodeURIComponent(q)}`;
    if (near) url += `&viewbox=${near.west},${near.north},${near.east},${near.south}`;
    try {
      const data = await getJSON(url);
      if (data.length) {
        return data.map(r => {
          const parts = r.display_name.split(',').map(s => s.trim());
          return { name: r.name || parts[0], address: parts.slice(1, 4).join(', '), lat: +r.lat, lng: +r.lon };
        });
      }
    } catch (e) { console.warn('Nominatim :', e.message); }
    let purl = `${PHOTON}?limit=6&lang=fr&q=${encodeURIComponent(q)}`;
    if (near) purl += `&lat=${(near.north + near.south) / 2}&lon=${(near.east + near.west) / 2}`;
    const data = await getJSON(purl);
    return (data.features || []).map(f => {
      const p = f.properties;
      return {
        name: p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city,
        address: [p.street, p.district, p.city, p.country].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
      };
    });
  }

  // Nominatim demande au plus une requête par seconde : file d'attente.
  const queue = [];
  let busy = false;
  function reverse(lat, lng) {
    return new Promise(resolve => { queue.push({ lat, lng, resolve }); pump(); });
  }
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { lat, lng, resolve } = queue.shift();
      let label = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      try {
        const d = await getJSON(`${NOMINATIM}reverse?format=jsonv2&accept-language=fr&zoom=17&lat=${lat}&lon=${lng}`, { timeout: 10000 });
        const a = d.address || {};
        const road = [a.house_number, a.road || a.pedestrian || a.footway || a.path || a.park].filter(Boolean).join(' ');
        const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || a.city || a.town || a.village;
        label = [road, area].filter(Boolean).join(', ') || (d.display_name || '').split(',').slice(0, 2).join(',').trim() || label;
      } catch (e) {
        console.warn('Adresse :', e.message);
      }
      resolve(label);
      await sleep(1100);
    }
    busy = false;
  }

  HR.services = { route, straight, elevation, search, reverse };
})();
