/*
 * Comptes et bibliothèque de trajets.
 *
 * Avec Supabase configuré (config.js), chaque utilisateur se connecte par
 * e-mail + mot de passe et retrouve ses trajets sur tous ses appareils ;
 * la sécurité « chacun ne voit que ses trajets » est assurée côté base
 * (Row Level Security, voir supabase/schema.sql).
 *
 * Sans connexion, les trajets sont gardés sur l'appareil (localStorage).
 *
 * Un trajet : { id, name, distance, gain, loop, points:[{lat,lng,label}],
 *               path: polyligne encodée, source, created_at, updated_at }
 */
(() => {
  'use strict';
  const { LS, uid } = HR;
  const cfg = window.HARES_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  const client = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;

  let user = null;
  const listeners = new Set();

  async function init() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    user = data.session ? data.session.user : null;
    client.auth.onAuthStateChange((event, session) => {
      user = session ? session.user : null;
      listeners.forEach(f => f(event, user));
    });
    return user;
  }
  const onAuth = f => listeners.add(f);

  // messages d'erreur Supabase traduits pour l'utilisateur
  function explain(error) {
    const m = (error && (error.message || error.error_description)) || '';
    if (/invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
    if (/email not confirmed/i.test(m)) return 'Confirme d’abord ton adresse : ouvre le lien reçu par e-mail.';
    if (/already registered|already exists/i.test(m)) return 'Un compte existe déjà avec cet e-mail. Connecte-toi.';
    if (/password.*(at least|6|8)/i.test(m)) return 'Le mot de passe est trop court (8 caractères minimum).';
    if (/rate limit|too many/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
    if (/fetch|network/i.test(m)) return 'Connexion au serveur impossible. Vérifie ta connexion internet.';
    return m || 'Une erreur est survenue.';
  }
  async function call(promise) {
    const { data, error } = await promise;
    if (error) throw new Error(explain(error));
    return data;
  }

  const auth = {
    signIn: (email, password) => call(client.auth.signInWithPassword({ email, password })),
    signUp: (email, password) => call(client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })),
    signOut: () => call(client.auth.signOut()),
    resetPassword: email => call(client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname })),
    updatePassword: password => call(client.auth.updateUser({ password })),
  };

  // ---------- bibliothèque ----------
  const local = {
    all: () => LS.get('library', []),
    put(list) { LS.set('library', list); },
  };
  const remote = () => enabled && user;
  const FIELDS = 'id,name,distance,gain,loop,points,path,source,created_at,updated_at';

  async function list() {
    if (remote()) return call(client.from('routes').select(FIELDS).order('updated_at', { ascending: false }));
    return local.all().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  /** Crée ou met à jour (si `r.id` existe déjà dans la bibliothèque courante). */
  async function save(r) {
    const now = new Date().toISOString();
    const row = { name: r.name, distance: r.distance, gain: r.gain ?? null, loop: !!r.loop, points: r.points, path: r.path, source: r.source || null, updated_at: now };
    if (remote()) {
      if (r.id && !String(r.id).startsWith('local-')) {
        const rows = await call(client.from('routes').update(row).eq('id', r.id).select(FIELDS));
        if (rows.length) return rows[0];
      }
      const rows = await call(client.from('routes').insert(row).select(FIELDS));
      return rows[0];
    }
    const all = local.all();
    const i = r.id ? all.findIndex(x => x.id === r.id) : -1;
    const rec = { ...row, id: i >= 0 ? r.id : 'local-' + uid(), created_at: i >= 0 ? all[i].created_at : now };
    if (i >= 0) all[i] = rec; else all.push(rec);
    local.put(all);
    return rec;
  }

  async function remove(id) {
    if (remote() && !String(id).startsWith('local-')) return call(client.from('routes').delete().eq('id', id));
    local.put(local.all().filter(x => x.id !== id));
  }

  /** Copie les trajets gardés sur l'appareil dans le compte connecté. */
  async function importLocal() {
    const all = local.all();
    if (!remote() || !all.length) return 0;
    const rows = all.map(({ id, created_at, ...r }) => r);
    await call(client.from('routes').insert(rows));
    local.put([]);
    return rows.length;
  }

  HR.store = {
    enabled, init, onAuth, auth, list, save, remove, importLocal,
    localCount: () => local.all().length,
    get user() { return user; },
  };
})();
