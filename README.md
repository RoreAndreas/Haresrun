# HARES RUN — trajets de course, à tracer, générer, partager et suivre

Appli web de course à pied, sombre et épurée, pensée pour le téléphone :

- **Tracer** un trajet point par point sur la carte, ou **générer une boucle
  aléatoire** de N km autour de son départ (avec l'animation de l'exploration
  des rues).
- **Suivre** un trajet avec le GPS : position sur le tracé, distance faite et
  restante, alerte si on sort du parcours.
- **Partager** un trajet par un simple lien, que n'importe qui peut ouvrir et
  suivre, sans compte.
- **Mes trajets** : bibliothèque des trajets enregistrés, liée au compte de
  chacun (e-mail + mot de passe).
- Distance, dénivelé, **allure** à tenir pour le temps prévu, **image PNG**
  du trajet.

Page statique : aucun build, le dossier `site/` est publié tel quel.

```
haresrun/
├── site/                  le dossier publié, tel quel
│   ├── index.html, style.css, favicon.svg
│   ├── config.js          ← réglages : centre par défaut, clés Supabase
│   ├── js/
│   │   ├── app.js         interface et logique de l'appli
│   │   ├── mapview.js     carte MapLibre, styles, tracé, animations
│   │   ├── generator.js   boucles aléatoires (Dijkstra, A*)
│   │   ├── worker.js      calculs de boucle en arrière-plan (Web Worker)
│   │   ├── genclient.js   lien entre l'interface et le worker
│   │   ├── streets.js     réseau des rues : tuiles de la carte, Overpass, cache
│   │   ├── follow.js      suivi GPS d'un trajet
│   │   ├── store.js       comptes et bibliothèque (Supabase ou appareil)
│   │   ├── services.js    itinéraires, altitudes, recherche d'adresses
│   │   ├── poster.js      image PNG (1080 × 1350)
│   │   └── util.js        outils communs
│   └── vendor/            MapLibre GL 4.7.1 (BSD), supabase-js 2.45.4 (MIT)
├── supabase/schema.sql    table des trajets et règles d'accès
└── serve.py               aperçu local
```

## Hares

La mascotte est **Hares**, le spartiate de l'open space (dépôt
`RoreAndreas/Openspace43`) : casque de bronze à aigrette rouge, cape,
bouclier au lambda et lance. Ses images (`site/img/hares-*.png`) sont
tirées telles quelles du moteur pixel art de l'open space
(`src/engine/robots.ts`, gabarit 20 × 24) : course (4 images), debout,
bras levés (2 images). On le voit sur l'écran d'entrée, dans le logo,
pendant la génération d'une boucle, dans la bibliothèque vide et à
l'arrivée d'un suivi GPS.

## Accès

L'appli s'ouvre sur un écran d'entrée : **se connecter** (ou créer un
compte), ou saisir la **clé d'accès**.

| | Sans compte (clé d'accès) | Avec un compte |
|---|---|---|
| Tracer, générer, suivre ses trajets | oui | oui |
| Mes trajets | sur cet appareil seulement (perdus si on efface les données du navigateur) | en ligne, sur tous ses appareils |
| Partager un trajet | non | oui |
| Ouvrir un lien partagé | oui, pour le voir | oui |
| Suivre un trajet partagé | non | oui |

Sans compte ni clé, un lien partagé s'ouvre quand même, en consultation :
le trajet s'affiche, mais pour le suivre ou l'enregistrer il faut se
connecter (le suivi démarre aussitôt après la connexion).

La clé est vérifiée par son empreinte SHA-256 (elle n'apparaît pas en
clair dans le code) et reste mémorisée sur l'appareil. C'est un verrou
d'interface : le code d'un site web étant public, il décourage l'accès
sans être une protection forte. Les trajets enregistrés, eux, sont
protégés par les règles Supabase. Pour changer la clé : calculer
l'empreinte de la nouvelle
(`node -e "console.log(require('crypto').createHash('sha256').update('NOUVELLE_CLE').digest('hex'))"`)
et la mettre dans `KEY_HASH` (`site/js/app.js`).

## Lancer

```bash
python serve.py
```

puis ouvrir <http://localhost:8000>. La géolocalisation n'est permise par
les navigateurs que sur `https://` ou `localhost`.

## Activer les comptes (Supabase, gratuit)

Sans cette étape, l'appli marche entièrement, mais les trajets enregistrés
restent sur l'appareil. Avec, chacun se crée un compte et retrouve ses
trajets partout.

1. Créer un compte sur <https://supabase.com>, puis **New project** (choisir
   une région proche, par ex. `West EU`). Le plan gratuit suffit.
2. **SQL Editor → New query** : coller le contenu de `supabase/schema.sql`,
   puis **Run**. Cela crée la table des trajets et les règles qui ne
   laissent chacun voir que les siens.
3. **Authentication → URL Configuration** : dans *Site URL*, mettre
   l'adresse du site publié (par ex. `https://haresrun.pages.dev`), et
   l'ajouter aussi dans *Redirect URLs* avec `http://localhost:8000`. C'est
   là que mènent les liens de confirmation et de mot de passe oublié.
4. **Project Settings → API** : copier *Project URL* et la clé
   *anon public* dans `site/config.js` (`supabaseUrl`, `supabaseAnonKey`).
   Cette clé est faite pour être publique ; ne jamais y mettre la clé
   *service_role*.

Par défaut, Supabase demande de confirmer l'adresse e-mail par un lien
avant la première connexion (réglable dans **Authentication → Providers →
Email**). Le service d'e-mails intégré de Supabase est limité à quelques
envois par heure : pour un vrai lancement, brancher un service d'envoi
(**Authentication → Emails → SMTP Settings**).

## Comment ça marche

- **Tracer** : chaque point touché prolonge le trajet ; le dernier est
  l'arrivée (D = départ, A = arrivée) : on ne revient pas au départ, sauf
  si l'on coche **Retour au départ**. Ajouter un point à une boucle
  générée en fait un aller simple jusqu'à ce point. Les repères se
  déplacent en les glissant ; **Par les rues** décoché relie les
  points en ligne droite.
- **Aléatoire** : on choisit la distance, HARES RUN récupère les rues
  autour du départ, les explore depuis le départ par l'algorithme de
  Dijkstra — c'est l'animation (2,5 s), les rues s'allument par ordre de
  distance — puis compare 16 boucles candidates et garde la meilleure :
  - **au moins 90 % de rues nouvelles** : on ne repasse presque jamais par
    une rue déjà courue (règle stricte, pas seulement une préférence) ;
  - bonne distance (±7 % visé), voies agréables (chemins et petites rues
    plutôt que grands axes, parkings, escaliers), peu de virages, forme
    ronde, points de passage jamais dans une impasse ;
  - « Générer » à nouveau propose une boucle différente des 3 dernières.

  Une boucle sort en moins d'une seconde :
  - les rues sont lues directement dans les tuiles vectorielles de la carte
    (OpenFreeMap, niveau de détail maximal), servies par un CDN et souvent
    déjà en cache — pas de serveur lent à attendre ;
  - elles sont préchargées dès l'ouverture de l'onglet « Aléatoire », et
    gardées en mémoire : « Générer » à nouveau est immédiat ;
  - si les tuiles ne répondent pas, l'API Overpass prend le relais (plus
    lente), puis, en dernier recours, un calcul simple sans animation.
- **Suivre** : l'écran reste allumé pendant le suivi. Un site web ne peut
  lire le GPS que page ouverte et écran allumé : téléphone verrouillé, le
  suivi s'arrête (il faudrait une appli mobile installée pour ça).
- **Partager** : tout le trajet tient dans le lien (après `#`). Rien n'est
  envoyé à un serveur ; la personne qui l'ouvre peut le suivre ou
  l'enregistrer.

## Services utilisés (gratuits, sans clé)

| Fonction | Service |
|---|---|
| Carte « Épurée » | OpenFreeMap (tuiles vectorielles OpenStreetMap), style maison : rues et noms des rues |
| Carte « Complète » | tuiles OpenStreetMap standard, assombries |
| Carte « Satellite » | imagerie Esri World Imagery |
| Itinéraire piéton | OSRM de FOSSGIS (`routing.openstreetmap.de`) |
| Rues pour les boucles | API Overpass (OpenStreetMap) |
| Recherche, nom des points | Nominatim, Photon en secours |
| Dénivelé | Open-Meteo |
| Comptes, bibliothèque | Supabase (à configurer, voir plus haut) |

Ces services publics sont gratuits avec un usage raisonnable : parfait pour
un usage perso ou un club. Pour une appli très fréquentée, il faudrait
héberger ses propres serveurs d'itinéraires et de tuiles.

## Quand la carte manque de détails

OpenStreetMap est fait par ses utilisateurs : un sentier peut manquer. Le
bouton de fond (en bas à droite) passe à « Complète » ou « Satellite » ;
« Par les rues » décoché permet de tracer hors des chemins connus ;
le lien « Un chemin manque ? » ouvre l'éditeur OpenStreetMap à l'endroit
affiché pour l'ajouter, pour tout le monde.

## Si la position n'arrive pas

La position vient du navigateur, qui la demande au système.

- **Ordinateur Windows** : Paramètres → Confidentialité et sécurité →
  Localisation : activer « Services de localisation » **et** « Autoriser les
  applications de bureau à accéder à votre position ».
- **Certains navigateurs** (Brave, Opera…) n'ont pas de service de
  localisation : essayer Chrome, Edge ou Firefox.
- **Téléphone** : activer la localisation et autoriser le navigateur.

Si Google Maps, dans le même navigateur, ne trouve pas non plus ta
position, le blocage vient de l'appareil ou du navigateur.
