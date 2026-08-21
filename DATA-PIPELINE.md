# QM3 Standings — d'où viennent les données, et comment les mettre à jour

Doc de référence. Remplace l'ancienne note de cadrage `QM3STANDINGS-DB-NOTE.md`
(toutes ses questions ouvertes sont tranchées depuis le 2026-08-20).

---

## 1. En une phrase

La carte lit son classement **en direct depuis AllHereDB** à chaque chargement de page.
Modifier la base suffit : **aucun commit, aucun redéploiement**.

---

## 2. Comment ça marche

```
                  ┌─────────────────────────────┐
   navigateur ──▶ │ GET  /eeg/standings/qm3     │  public, sans auth
   du visiteur    │ api.allherelounge.com       │  cache: no-store
                  └─────────────────────────────┘
                                │ si injoignable (timeout 3 s, 404, CORS)
                                ▼
                  assets/data/leaderboard.json   ← repli embarqué dans le site
```

- **Source de vérité : AllHereDB**, document `qm3`.
- **Repli** : `assets/data/leaderboard.json`, versionné dans le dépôt. Il n'est servi
  que si l'API ne répond pas. On le garde **définitivement** : une panne d'API devient
  « données un peu datées » au lieu d'une page blanche.
- La lecture se fait **au chargement de la page**. Une page déjà ouverte ne se rafraîchit
  pas toute seule (pas de rafraîchissement périodique aujourd'hui).

### Configuration (`index.html`)

| Option | Rôle |
|---|---|
| `eegApiBase` | Racine de l'API. **Split-ready** : passer à `https://neuro.allherelounge.com` le jour où l'Espace Cérébral déménage — rien d'autre à changer. |
| `dataUrl` | Le fichier de repli. Le `?v=N` est un anti-cache : **l'incrémenter à chaque modification du fichier**. |
| `listTop` | Nombre d'entrées classées affichées (10). |

---

## 3. Mettre à jour le classement

```bash
# 1. éditer le document
$EDITOR assets/data/leaderboard.json

# 2. vérifier sans rien envoyer
python3 build/push-standings.py --dry-run

# 3. publier vers la base (+ contrôle automatique)
python3 build/push-standings.py

# 4. incrémenter ?v= dans index.html, puis committer le repli
git add assets/data/leaderboard.json index.html && git commit && git push
```

**Ordre important : la base d'abord, le commit ensuite.** Le fichier local est le repli —
il ne doit jamais être plus vieux que la source. Dans ce sens, une interruption en cours
de route laisse toujours un état cohérent.

Le script refuse de publier un JSON invalide ou une liste d'entrées vide, puis relit la
base et compare champ par champ avec le local. Il sort en code 0 seulement si les deux
sont identiques.

⚠️ **L'écriture remplace le document en entier** (pas de fusion). On envoie toujours le
document complet — c'est la seule opération destructive de la chaîne.

---

## 4. Format du document

```jsonc
{
  "meta": {
    "title": "World Meditation Challenge", "listTitle": "QM3 Standings",
    "unit": "CMI",            // le libellé de la métrique
    "scaleMax": 385,          // borne haute des barres
    "updated": "2026-07-18",
    "count": "400+",          // texte libre, affiché tel quel
    "oneDotEach": true,       // un point par personne, pas de bulles de comptage
    "note": "SMI coming up soon.",
    "learnMoreUrl": "https://www.wml.org"
  },
  "entries": [ … ]
}
```

Trois types d'entrées :

| Type | Champs | Rendu |
|---|---|---|
| **Classée** | `city`, `country`, `cmi`, `lat`, `lon` | Point + rang + score, listée |
| **Mise en avant** (VIP) | idem + `vip: {name, photo, tag?, bio?}` | Fiche au survol avec photo et bio |
| **Marqueur** | `city`, `country`, `dot: true`, `lat`, `lon` | Point jaune, survol = nom de ville seulement |

- `lat`/`lon` sont **obligatoires** — le géocodage par nom n'est plus utilisé.
- `tag` et `bio` sont **optionnels** (Tokyo n'a pas de `tag`, c'est normal).
- `vip.photo` doit être une **URL absolue** — le document est aussi lu par d'autres clients
  (app mobile, outils internes) pour qui un chemin relatif ne veut rien dire.

### 🔒 Règle absolue sur les scores

**Ne jamais inventer ni déduire un score.** Un `cmi` affiché vient uniquement :

1. d'un fichier `QM3_results.csv` (champ `mapIndex`), **pour la bonne personne et la bonne ville** ; ou
2. d'une valeur QM3 fournie manuellement par Loup (ex. les valeurs officielles WML).

Tout autre lieu est un **marqueur** (`dot: true`), sans score. Associer une vraie valeur à
la mauvaise ville est une invention — c'est déjà arrivé, ne pas recommencer.

> Vocabulaire : **CMI** est la métrique (c'est le libellé affiché).
> **QM3** est la méthode de mesure (les 3 meilleures minutes). Ne pas confondre les deux.

> **`meta.title` n'est plus lu par la page.** Le titre de la une est le nom de
> l'événement — « World Meditation Challenge » — et il est fixe dans
> `assets/leaderboard.js`. Le laisser piloter par le flux remettait « QM3 Standings »
> à chaque chargement, puisque c'est encore ce que renvoie
> `GET /eeg/standings/qm3`. « QM3 Standings » est passé au sur-titre. `meta.listTitle`
> pilote toujours le panneau de classement, lui.

---

## 5. Sécurité

**Le dépôt est public** (c'est GitHub Pages qui sert le site). Il ne contient aucun secret,
et ne doit jamais en contenir.

| | Qui | Auth | Où ça tourne |
|---|---|---|---|
| **Lecture** | tout visiteur | aucune | navigateur |
| **Écriture** | Loup | clé d'admin | **son portable uniquement** |

- Le token vit dans `build/.qm3-token` (`chmod 600`). `build/` est ignoré par git.
  Le script refuse de démarrer si le fichier est lisible par d'autres.
- `QM3_ADMIN_TOKEN` en variable d'environnement est prioritaire, si on préfère l'export manuel.
- C'est une **clé d'administration personnelle**, révocable seule sans casser les autres accès.
- Le token **n'est jamais utilisé par le site** : le navigateur ne fait que lire.
- Ne jamais publier les données EEG sources : `data/`, `data2/`, `data3/`, `build/` sont ignorés.

**Passer le dépôt en privé ne protégerait rien** (il n'y a pas de secret dedans) et casserait
deux choses : GitHub Pages sur dépôt privé demande un plan payant, et les URLs absolues des
photos cesseraient de répondre.

---

## 6. Pièges connus

- **Photos et `?v=` peuvent désynchroniser.** Le lien vit en base, l'image dans le dépôt.
  Si on remplace une photo sans republier le document, l'ancien `?v=` reste et le cache
  sert l'ancienne image. → Remplacer l'image **et** incrémenter le `?v=` dans le document,
  puis republier.
- **La base réindente et réordonne les clés JSON.** La taille en octets diffère du fichier
  local ; c'est sans conséquence (`JSON.parse` s'en moque). Comparer les documents
  **désérialisés**, jamais les octets.
- **Le repli est silencieux.** Si l'API tombe, le site affiche les données locales sans rien
  dire (juste un `console.warn`). Pour vérifier qu'on lit bien la base :
  ```bash
  curl -s -D - -o /dev/null -H "Origin: https://allheregeneva.github.io" \
    https://api.allherelounge.com/eeg/standings/qm3
  ```
  Attendu : `200` **et** `access-control-allow-origin: *` sur la vraie réponse.

---

## 7. Fichiers

| Chemin | Suivi ? | Rôle |
|---|---|---|
| `assets/data/leaderboard.json` | oui | Le document — repli du site |
| `assets/data/world-land.json` | oui | Géométrie du planisphère (statique, 1,3 Mo) |
| `assets/data/gazetteer.json` | oui | Ville → coordonnées, **inutilisé** (toutes les entrées ont `lat`/`lon`) |
| `assets/participants/*.jpg` | oui | Photos, servies par GitHub Pages |
| `build/push-standings.py` | **non** | Publication vers la base |
| `build/.qm3-token` | **non** | Clé d'admin (`chmod 600`) |
| `data/`, `data2/`, `data3/` | **non** | Données EEG sources — ne jamais publier |
