/*
 * Réglages de HARES RUN.
 *
 * googleMapsApiKey : ta clé Google Maps Platform. Laisse vide pour la saisir
 * dans l'appli (elle est alors gardée dans le navigateur, pas dans le dépôt).
 * Si tu la mets ici, restreins-la à ton domaine dans la console Google Cloud
 * (Restrictions d'application → Sites web) : ce fichier est public.
 *
 * defaultCenter : où la carte s'ouvre quand la localisation est refusée.
 */
window.HARES_CONFIG = {
  googleMapsApiKey: "",
  defaultCenter: { lat: 5.3364, lng: -4.0267 }, // Abidjan
  defaultZoom: 14,
};
