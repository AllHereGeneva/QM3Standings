# Note QM3Standings — lire les classements depuis la BDD Infomaniak

Statut : **note de cadrage, à planifier**. Décidé le 2026-08-20. Contexte : mémoire `eeg-bridge`,
carte système (artifact `fbde9996-58a5-47cd-a222-b72750317e1c`).

## En clair

Aujourd'hui QM3Standings lit un **fichier placeholder** (données de classement figées). On veut
qu'il lise ses données **depuis la base Infomaniak (AllHereDB)** au lieu d'un fichier embarqué,
et — **en attendant** qu'on ait un vrai jeu de données — qu'on **y copie le placeholder actuel**
pour qu'il ait quelque chose à afficher tout de suite.

## Ce qu'il faut faire

1. **Étape provisoire (débloque tout de suite)** : copier le contenu du fichier placeholder
   actuel dans la BDD, à un emplacement fixe, pour que QM3Standings lise depuis là.
2. **Changer la lecture de QM3Standings** : au lieu de lire le fichier embarqué, il va chercher
   ses données à cet emplacement en base.
3. Quand un vrai jeu de données existera, il remplacera le placeholder au même emplacement —
   sans retoucher QM3Standings.

## Décisions à confirmer avant de coder (⚠️ je ne connais pas encore les détails QM3)

- **Accès direct BDD vs via l'API ?** Notre principe d'architecture : les apps lisent **via
  l'Espace Cérébral** (le service « neuro », endpoint de classement), pas directement dans la
  base. → Si QM3Standings tourne **côté build/offline**, lire la base directement est acceptable.
  S'il tourne **côté client** (dans le navigateur), il doit passer par un endpoint, pas par la
  base. **À trancher selon la nature de QM3Standings.**
- **Où exactement en base ?** un emplacement dédié (p. ex. une ligne « standings » identifiée par
  un nom) — à définir avec l'agent api/neuro pour ne pas mélanger avec `eeg_sessions`.
- **Format** : conserver le format exact du fichier placeholder actuel (pour ne rien casser côté
  rendu) — donner le chemin du placeholder + un exemple de son contenu.
- **Split-ready** : si l'accès se fait via un endpoint, utiliser une **adresse de config dédiée**
  (aujourd'hui `api.allherelounge.com`, demain `neuro.allherelounge.com`).

## À fournir pour rendre cette note actionnable

- Le **chemin du fichier placeholder** actuel + son format.
- Confirmer si QM3Standings est **build-time** ou **client navigateur**.
