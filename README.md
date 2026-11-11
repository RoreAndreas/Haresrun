# HARES RUN — parcours de course sur OpenStreetMap

Planificateur de parcours de course à pied, en sombre et sans fioritures.
On place un **départ**, des **étapes** et une **arrivée** sur la carte (ou on
part de sa position), HARES RUN calcule l'itinéraire piéton, la distance, le
dénivelé, et l'**allure** à tenir pour finir dans le temps prévu. Le
parcours s'exporte en **image PNG** avec ces informations.

**Gratuit, sans clé ni compte** : tout repose sur OpenStreetMap et des
services publics gratuits. Page statique : aucun build, le dossier `site/`
est publié tel quel.

```
haresrun/
├── site/              le dossier publié, tel quel
│   ├── index.html
│   ├── style.css
│   ├── app.js         carte, points, itinéraire, allure
│   ├── poster.js      l'image PNG (1080 × 1350)
│   ├── config.js      ← réglages : centre de la carte par défaut
│   ├── vendor/leaflet bibliothèque de carte (Leaflet 1.9.4, licence BSD)
│   └── favicon.svg
└── serve.py           aperçu local
```

## Lancer

```bash
python serve.py
```

puis ouvrir <http://localhost:8000>. La géolocalisation n'est permise par
les navigateurs que sur `https://` ou `localhost` : ouvrir `index.html`
directement (`file://`) ne la donnerait pas.

## Services utilisés

| Fonction | Service | Remarque |
|---|---|---|
| Carte « Simplifiée » | fond gris foncé Esri (World Dark Gray Canvas) | épurée : rues principales et noms, rien d'autre |
| Carte « Complète » | tuiles OpenStreetMap standard, assombries | la plus détaillée : sentiers, pistes, bâtiments, commerces |
| Carte « Claire » | tuiles OpenStreetMap standard | la complète, en couleurs d'origine |
| Carte « Satellite » | imagerie Esri World Imagery | pour repérer ce qui n'est pas sur la carte |
| Itinéraire piéton | OSRM de FOSSGIS (`routing.openstreetmap.de`) | ligne droite si indisponible |
| Recherche, nom des points | Nominatim (OpenStreetMap), Photon en secours | une requête par seconde au plus |
| Dénivelé | Open-Meteo | |

Ces services publics sont gratuits avec un usage raisonnable : parfait pour
un usage perso ou un club. Pour une appli très fréquentée, il faudrait
héberger son propre serveur d'itinéraires et de tuiles.

## Quand la carte manque de détails

OpenStreetMap est fait par ses utilisateurs : selon les quartiers, un
sentier ou une piste peut manquer. Trois solutions, de la plus rapide à la
plus durable :

1. **Changer de fond** (menu en haut à droite) : « Complète » montre tous
   les chemins connus, « Satellite » montre le terrain réel. À l'inverse,
   « Simplifiée » allège la carte quand il y a trop de détails.
2. **Décocher « Suivre les chemins »** : les points sont reliés en ligne
   droite, pour courir là où la carte ne connaît pas de chemin. Avec la vue
   satellite et des étapes rapprochées, le tracé suit le vrai sentier.
3. **Ajouter le chemin à OpenStreetMap** : lien « Un chemin manque ? » en
   bas du panneau, qui ouvre l'éditeur à l'endroit affiché (compte gratuit).
   Le chemin apparaît ensuite sur la carte et dans les itinéraires, en
   général sous quelques jours, pour toi et pour tous les coureurs du coin.

## Utilisation

- **Clic sur la carte** : le premier clic place le départ (D), le deuxième
  l'arrivée (A). Ensuite, chaque clic — sur la carte ou sur le tracé —
  ajoute une **étape** (1, 2, 3…) dans le tronçon où elle allonge le moins
  le parcours. Les repères se déplacent en les faisant glisser ; × dans la
  liste supprime un point, un clic sur son nom centre la carte dessus.
- Le **sens** du parcours est indiqué par des flèches le long du tracé, sur
  la carte comme sur l'image exportée.
- **Partir de ma position** place le départ sur la position de l'appareil :
  le GPS est écouté quelques secondes et la mesure la plus précise est
  gardée (jusqu'à ±10 m). La précision s'affiche ; le cercle bleu sur la
  carte montre la marge d'erreur.
- **Boucle** : l'arrivée revient au départ. **Suivre les chemins** décoché :
  les points sont reliés en ligne droite.
- **Allure** : saisir le temps prévu donne l'allure au km, et inversement,
  avec la vitesse et l'heure d'arrivée.
- **Exporter en PNG** : on y donne un nom au run ; l'image reprend tracé,
  distance, temps prévu, allure, vitesse, dénivelé et nombre d'étapes, avec
  ou sans fond de carte.
- La recherche accepte un lieu ou des **coordonnées GPS** (`5.33641, -4.02672`).

Le parcours en cours est gardé dans le navigateur : il est là au retour.
« Annuler » (ou Ctrl+Z) revient sur la dernière modification.

### Si la position n'arrive pas

La position vient du navigateur, qui la demande au système. Un message
« trop de temps » signifie que le navigateur n'a rien renvoyé :

- **Sur ordinateur Windows** : Paramètres → Confidentialité et sécurité →
  Localisation : activer « Services de localisation » **et** « Autoriser les
  applications de bureau à accéder à votre position ». Sans GPS, un
  ordinateur se situe par le Wi-Fi (à quelques dizaines de mètres) ; en
  câble Ethernet, souvent pas du tout.
- **Certains navigateurs** (Brave, Opera, Chromium sans services Google…)
  n'ont pas de service de localisation : essayer Chrome, Edge ou Firefox.
- **Sur téléphone** : activer la localisation et autoriser le navigateur ;
  c'est là que le GPS donne une position précise.

Test rapide : si Google Maps, dans le même navigateur, ne trouve pas non
plus ta position, le blocage vient de l'appareil ou du navigateur, pas de
HARES RUN.

Limite : 50 points par parcours.
