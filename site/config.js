/*
 * Réglages de HARES RUN.
 *
 * defaultCenter : où la carte s'ouvre quand la localisation est refusée.
 * Carte, itinéraires, recherche et altitudes viennent de services gratuits
 * basés sur OpenStreetMap : aucune clé n'est nécessaire pour eux.
 *
 * Comptes et bibliothèque en ligne (Supabase) : recopier ici l'URL du
 * projet et sa clé « anon public » (Supabase → Project Settings → API).
 * Cette clé est faite pour être publique : la sécurité vient des règles de
 * la base (supabase/schema.sql), qui ne laissent chacun voir que ses
 * trajets. Laisser vide : pas de comptes, les trajets restent sur
 * l'appareil.
 */
window.HARES_CONFIG = {
  defaultCenter: { lat: 5.3364, lng: -4.0267 }, // Abidjan
  defaultZoom: 14,
  supabaseUrl: 'https://dkjsemjvebfrqtklrwge.supabase.co',
  supabaseAnonKey: 'sb_publishable_Pay2IVV_I3-zmSPcSCdhMw_ZlrLKO5k', // clé publique (publishable)
};
