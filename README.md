# HARES RUN — parcours de course sur Google Maps

Planificateur de parcours de course à pied, en sombre et sans fioritures.
On place un **départ**, des **étapes** et une **arrivée** sur la carte (ou on
part de sa position), HARES RUN calcule l'itinéraire piéton, la distance, le
dénivelé, et l'**allure** à tenir pour finir dans le temps prévu. Le
parcours s'exporte en **image PNG** avec ces informations.

Page statique : aucun build, le dossier `site/` est publié tel quel.

```
haresrun/
├── site/              le dossier publié, tel quel
│   ├── index.html
│   ├── style.css
│   ├── app.js         carte, points, itinéraire, allure
│   ├── poster.js      l'image PNG (1080 × 1350)
│   ├── config.js      ← réglages : clé Google Maps, centre par défaut
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

## En ligne (Cloudflare Pages)

Le site est publié sur Cloudflare Pages, projet `haresrun`, dossier
`site/`, sans commande de build. Une fois publié, ajouter l'adresse
`https://haresrun.pages.dev/*` aux sites autorisés de la clé Google Maps.

## La clé Google Maps

HARES RUN appelle Google directement depuis le navigateur, avec ta clé.

1. [Console Google Cloud](https://console.cloud.google.com/google/maps-apis/credentials) → créer une clé API (un compte de facturation est exigé ; le crédit mensuel gratuit couvre largement un usage perso).
2. Activer les API :

   | API | Sert à | Sans elle |
   |---|---|---|
   | Maps JavaScript API | la carte | rien ne marche |
   | Routes API | l'itinéraire piéton | repli sur Directions API, sinon ligne droite |
   | Geocoding API | le nom des points, la recherche | coordonnées à la place des adresses |
   | Places API (New) | la recherche de lieux | repli sur Geocoding |
   | Elevation API | le dénivelé | pas de dénivelé |
   | Maps Static API | le fond de carte du PNG | image sans fond de carte |

3. **Restreindre la clé** : *Restrictions d'application → Sites web*, avec
   `http://localhost:8000/*` et l'adresse du site publié.

Deux façons de la donner à HARES RUN :

- la saisir au premier lancement (lien « Clé API ») : elle est gardée dans
  le navigateur, rien dans le dépôt ;
- ou l'écrire dans `site/config.js` (`googleMapsApiKey`) : pratique pour un
  site publié, mais le fichier est public — d'où la restriction par site.

## Utilisation

- **Clic sur la carte** : le premier clic place le départ (D), le deuxième
  l'arrivée (A). Ensuite, chaque clic — sur la carte ou directement sur le
  tracé — ajoute une **étape** (1, 2, 3…), insérée dans le tronçon où elle
  allonge le moins le parcours. Les repères se déplacent en les faisant
  glisser (y compris l'arrivée) ; la liste permet de les renommer,
  réordonner, supprimer.
- Le **sens** du parcours est indiqué par des flèches le long du tracé, sur
  la carte comme sur l'image exportée.
- **Position exacte** : « Ma position » et « Départ = ma position »
  écoutent le GPS pendant quelques secondes et gardent la mesure la plus
  précise (jusqu'à ±10 m, ou la meilleure obtenue en 12 s). La position,
  ses coordonnées et la marge d'erreur s'affichent ; le cercle bleu sur la
  carte montre cette marge.
- **Coordonnées GPS** : la recherche accepte aussi des coordonnées
  (`5.33641, -4.02672`) pour placer un point au mètre près. Survoler la
  pastille d'un point affiche les siennes.
- **Boucle** : l'arrivée revient au départ.
- **Allure** : saisir le temps prévu donne l'allure au km, et inversement.
  Vitesse, temps à mi-parcours, heure d'arrivée et temps de passage à
  chaque km suivent.
- **Exporter en PNG** : tracé, distance, temps prévu, allure, vitesse,
  dénivelé, nombre d'étapes ; avec ou sans fond de carte Google.

Le parcours en cours est gardé dans le navigateur : il est là au retour.
« Annuler » (ou Ctrl+Z) revient sur la dernière modification.

Limite : 27 points par parcours (départ, arrivée et 25 étapes, le maximum
de Google pour un trajet à pied).
