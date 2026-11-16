/*
 * Suivi d'un trajet avec le GPS : position sur le tracé, distance faite et
 * restante, alerte si on sort du parcours. Rien n'est enregistré.
 *
 * Limite d'un site web : le GPS n'est lu que page ouverte et écran allumé.
 * On demande donc au téléphone de ne pas se mettre en veille (Wake Lock).
 */
(() => {
  'use strict';
  const { cumulative, project } = HR;

  const OFF_ROUTE = 40;   // mètres : au-delà, on est hors parcours
  const FINISH = 30;      // mètres avant la fin : arrivée

  let watchId = null, wakeLock = null, run = null;

  async function keepAwake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* refusé ou non pris en charge */ }
  }
  function onVisible() { if (run && document.visibilityState === 'visible') keepAwake(); }

  function start(path, { onUpdate, onFinish, onError }) {
    stop();
    const cum = cumulative(path);
    run = { path, cum, total: cum[cum.length - 1], progress: 0, off: false, t0: null, done: false, onUpdate, onFinish };
    keepAwake();
    document.addEventListener('visibilitychange', onVisible);
    if (!navigator.geolocation) { onError && onError({ code: 2 }); return; }
    watchId = navigator.geolocation.watchPosition(fix, err => onError && onError(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  function fix(pos) {
    if (!run) return;
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    const tol = Math.max(OFF_ROUTE, Math.min(80, (p.acc || 0) * 1.2));
    // d'abord autour de la progression actuelle (une boucle repasse aux mêmes endroits)…
    let hit = project(run.path, run.cum, p, run.progress, 600);
    // …puis sur tout le tracé si on est perdu
    if (!hit || hit.off > tol) {
      const any = project(run.path, run.cum, p);
      if (any && (!hit || any.off < hit.off)) hit = any;
    }
    const wasOff = run.off;
    run.off = !hit || hit.off > tol;
    if (!run.off) {
      if (run.t0 == null) run.t0 = Date.now();
      // On n'avance que vers l'avant (marge de 30 m pour le bruit GPS). Un
      // saut loin devant (portion du tracé qui passe tout près) n'est
      // accepté qu'après 3 relevés de suite : raccourci volontaire.
      const far = hit.along > run.progress + 600;
      run.farHits = far ? (run.farHits || 0) + 1 : 0;
      if (hit.along > run.progress - 30 && (!far || run.farHits >= 3)) run.progress = Math.max(run.progress, hit.along);
    }
    if (run.off && !wasOff && navigator.vibrate) navigator.vibrate([250, 120, 250]);
    const elapsed = run.t0 == null ? 0 : (Date.now() - run.t0) / 1000;
    const state = {
      pos: p, progress: run.progress, remaining: Math.max(0, run.total - run.progress), total: run.total,
      offRoute: run.off, offBy: hit ? hit.off : null, elapsed,
      pace: run.progress > 150 ? elapsed / (run.progress / 1000) : null,
    };
    run.onUpdate && run.onUpdate(state);
    if (!run.done && !run.off && state.remaining < FINISH && run.progress > run.total * 0.5) {
      run.done = true;
      if (navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 300]);
      run.onFinish && run.onFinish(state);
    }
  }

  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    document.removeEventListener('visibilitychange', onVisible);
    run = null;
  }

  HR.follow = { start, stop, get active() { return !!run; } };
})();
