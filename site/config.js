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
  // clé publique « anon » (Legacy API keys) ; la clé « publishable » marche aussi
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRranNlbWp2ZWJmcnF0a2xyd2dlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ4MzY4NTUsImV4cCI6MjExMDQxMjg1NX0.ULcmXRIiQQu2D3ukMSjJgM6xmZ0HOUL-K-KOs1yPKkM',
};
