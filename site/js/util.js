/*
 * Outils communs : formats, géométrie, polylignes, stockage local.
 * Tout est rangé sous window.HR pour être partagé entre les fichiers.
 */
window.HR = window.HR || {};
(() => {
  'use strict';

  const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pad = n => String(n).padStart(2, '0');

  const fmt = {
    km: m => nf2.format((m || 0) / 1000),
    km1: m => nf1.format((m || 0) / 1000),
    speed: paceSec => (paceSec > 0 ? nf1.format(3600 / paceSec) : '—'),
    pace(sec) {
      if (!(sec > 0) || !isFinite(sec)) return '—';
      sec = Math.round(sec);
      return `${Math.floor(sec / 60)}:${pad(sec % 60)}`;
    },
    dur(sec) {
      if (!(sec >= 0) || !isFinite(sec)) return '—';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
      return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    },
    date: d => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
    pad,
  };

  // ---------- géométrie ----------
  const R = 6371008.8, RAD = Math.PI / 180;
  function dist(a, b) {
    const h = Math.sin((b.lat - a.lat) * RAD / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin((b.lng - a.lng) * RAD / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function pathLength(path) {
    let d = 0;
    for (let i = 1; i < path.length; i++) d += dist(path[i - 1], path[i]);
    return d;
  }
  /** Point à `d` mètres dans la direction `bearing` (degrés) depuis `p`. */
  function offset(p, d, bearing) {
    const br = bearing * RAD, la = p.lat * RAD, lo = p.lng * RAD, a = d / R;
    const la2 = Math.asin(Math.sin(la) * Math.cos(a) + Math.cos(la) * Math.sin(a) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(a) * Math.cos(la), Math.cos(a) - Math.sin(la) * Math.sin(la2));
    return { lat: la2 / RAD, lng: lo2 / RAD };
  }
  /** Coordonnées locales en mètres autour de `o` (assez précis à l'échelle d'un quartier). */
  function toXY(p, o) {
    return { x: (p.lng - o.lng) * RAD * R * Math.cos(o.lat * RAD), y: (p.lat - o.lat) * RAD * R };
  }

  /**
   * Point du tracé le plus proche de `p`, cherché de préférence à partir de
   * `from` (en mètres) pour suivre une boucle qui repasse au même endroit.
   * Rend { along, off } : distance parcourue sur le tracé et écart au tracé.
   */
  function project(path, cum, p, from = 0, window = Infinity) {
    let best = null;
    for (let i = 1; i < path.length; i++) {
      if (cum[i] < from - 50 || cum[i - 1] > from + window) continue;
      const a = toXY(path[i - 1], p), b = toXY(path[i], p);
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
      const off = Math.hypot(a.x + dx * t, a.y + dy * t);
      if (!best || off < best.off) best = { off, along: cum[i - 1] + (cum[i] - cum[i - 1]) * t };
    }
    return best;
  }
  function cumulative(path) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
    return cum;
  }
  /** `n` points régulièrement espacés le long du tracé. */
  function resample(path, n) {
    const cum = cumulative(path), total = cum[cum.length - 1], out = [];
    let j = 1;
    for (let k = 0; k < n; k++) {
      const d = total * k / (n - 1);
      while (j < path.length - 1 && cum[j] < d) j++;
      const seg = cum[j] - cum[j - 1], t = seg ? (d - cum[j - 1]) / seg : 0;
      out.push({ lat: path[j - 1].lat + (path[j].lat - path[j - 1].lat) * t, lng: path[j - 1].lng + (path[j].lng - path[j - 1].lng) * t });
    }
    return out;
  }
  /** Simplification de Douglas-Peucker, tolérance en mètres. */
  function simplify(path, tol = 4) {
    if (path.length < 3) return path.slice();
    const o = path[0], pts = path.map(p => toXY(p, o)), keep = new Uint8Array(path.length);
    keep[0] = keep[path.length - 1] = 1;
    const stack = [[0, path.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const a = pts[s], b = pts[e], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
      let maxD = 0, idx = -1;
      for (let i = s + 1; i < e; i++) {
        // extrémités confondues (boucle) : distance au point lui-même
        const d = L < 1e-6 ? Math.hypot(pts[i].x - a.x, pts[i].y - a.y)
          : Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / L;
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return path.filter((_, i) => keep[i]);
  }

  // ---------- polylignes encodées (format Google, précision 1e-5) ----------
  function encodePolyline(path) {
    let out = '', plat = 0, plng = 0;
    const enc = v => {
      v = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const p of path) {
      const la = Math.round(p.lat * 1e5), lo = Math.round(p.lng * 1e5);
      out += enc(la - plat) + enc(lo - plng);
      plat = la; plng = lo;
    }
    return out;
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

  // ---------- divers ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('haresrun.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('haresrun.' + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
    del(k) { try { localStorage.removeItem('haresrun.' + k); } catch { /* idem */ } },
  };
  async function getJSON(url, { timeout = 15000, ...opts } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  function toast(msg, ms = 3000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
  }

  Object.assign(HR, {
    fmt, dist, pathLength, offset, toXY, project, cumulative, resample, simplify,
    encodePolyline, decodePolyline, LS, getJSON, sleep, uid, esc, toast,
  });
})();
