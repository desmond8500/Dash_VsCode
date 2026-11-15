# Dash Lite

Un éditeur léger au look de VS Code pour piloter plusieurs projets au quotidien, **quel que soit leur type**
(web, Laravel/PHP, Node, Python, Go, Rust, .NET, Java, Flutter, Docker…) : basculer d'un projet à l'autre,
éditer ses fichiers TODO/Markdown, synchroniser ses dépôts git et lancer ses commandes (build, déploiement, tests…).

**Un seul fichier exécutable, rien à installer.** Double-cliquez : l'application s'ouvre dans sa propre fenêtre.
Fermez la fenêtre : l'application s'arrête.

## Téléchargement et lancement

Les exécutables sont publiés dans les [Releases](https://github.com/desmond8500/Dash_VsCode/releases) du dépôt.

| Système | Fichier | Lancer |
|---|---|---|
| Windows 10/11 (PC classique) | `DashLite-Windows-x64.exe` | double-clic |
| Windows sur ARM | `DashLite-Windows-ARM64.exe` | double-clic |
| Linux (x64 / ARM64) | `DashLite-Linux-x64.tar.gz` → `DashLite` | double-clic ou `./DashLite` |

Le fichier se déplace où vous voulez (Bureau, clé USB, `~/Applications`…). Votre configuration
(projets, commandes enregistrées, onglets ouverts) est rangée à part, dans votre dossier utilisateur :

- Windows : `%AppData%\DashLite`
- Linux : `~/.config/DashLite`

**Mode portable** : créez un dossier `DashLite-data` à côté de l'exécutable ; la configuration y sera stockée
et voyagera avec l'application (pratique sur une clé USB).

Sous Linux, menu ☰ → *Ajouter au menu des applications* crée un lanceur (avec l'icône) qui pointe vers l'exécutable.

## Mises à jour automatiques

Dash Lite vérifie au démarrage puis toutes les 6 heures si une nouvelle version est publiée dans les Releases GitHub.
En mode **automatique** (par défaut), il la télécharge en arrière-plan, vérifie sa somme SHA-256, remplace l'exécutable
et affiche « Redémarrer » : la nouvelle version est utilisée tout de suite si vous redémarrez, sinon au prochain lancement.
Les modes *Me prévenir seulement* et *Désactivées* se choisissent dans les Paramètres. Menu ☰ → *Rechercher des mises à jour*
pour vérifier à la main.

Le dossier de l'exécutable doit être modifiable (sinon Dash Lite indique la page de téléchargement).

### Publier une nouvelle version

```bash
git tag v1.2.0
git push origin v1.2.0
```

Le workflow GitHub Actions `.github/workflows/release.yml` compile alors les exécutables Windows et Linux avec ce numéro
de version, calcule `SHA256SUMS` et crée la Release. Les copies installées la récupèrent toutes seules.

### Premier lancement (application non signée)

- **Windows** : SmartScreen peut afficher « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
- **Linux** : si le double-clic ne lance rien, rendez le fichier exécutable (`chmod +x DashLite`).

### La fenêtre

Dash Lite affiche son interface dans une fenêtre « application » de **Chrome, Edge, Brave ou Chromium** (sans barre d'adresse).
Edge est présent d'office sous Windows. Sans aucun de ces navigateurs, l'interface s'ouvre dans votre navigateur par défaut.
Relancer l'exécutable alors qu'il tourne déjà rouvre simplement une fenêtre.

Pré-requis facultatif : **git** (pour la vue Git et le clonage). Les commandes lancées utilisent les outils déjà installés
sur votre machine (npm, php, composer, python, flutter…).

## Fonctionnalités

### Projets
- Ajout d'un dossier existant (sélecteur de dossiers intégré) ou **clonage d'un dépôt git** qui devient un projet.
- Bascule instantanée : `Ctrl+R`, le nom du projet dans la barre de titre ou la vue **Projets**.
- Chaque projet garde ses onglets ouverts, son explorateur, son historique de terminal et ses sessions.

### Explorateur et éditeur
- Arborescence avec création en ligne (`Alt+N`), renommage (`F2`), suppression (`Suppr`), glisser-déposer, menu clic droit,
  filtre « Markdown seulement », couleurs git (modifié / nouveau).
- Onglets (aperçu en italique, ● = non enregistré, glisser pour réordonner), `Ctrl+P` pour ouvrir un fichier par recherche floue.
- Éditeur avec **coloration syntaxique** (JavaScript/TypeScript, JSON, PHP/Blade, Python, Go, Rust, Java, Kotlin, C#, C/C++,
  Dart, Swift, HTML/XML/Vue, CSS/SCSS, Markdown, YAML, TOML/INI/.env, Shell, PowerShell, Batch, SQL, Dockerfile, Makefile),
  ligne courante surlignée, numéros de ligne, indentation détectée, `Tab`/`Maj+Tab`, `Alt+↑/↓` déplacer la ligne, `Ctrl+D` dupliquer,
  `Ctrl+/` commenter, retour à la ligne (`Alt+Z`), `Ctrl+G` aller à la ligne, conserve CRLF/BOM/Latin-1.
- **Détection des conflits** : si git ou un autre programme modifie un fichier ouvert, il est rechargé s'il n'a pas de
  modifications ; sinon Dash propose de recharger ou d'écraser.
- Enregistrement automatique optionnel (barre d'état). Images affichées dans un onglet dédié.

### Markdown et TODO
- Modes **Éditer / Partagé / Aperçu** (`Ctrl+Maj+V`) : titres, tableaux, listes imbriquées, blocs de code, citations et
  encadrés `> [!NOTE]`, images relatives, liens entre fichiers `.md` (cliquables).
- **Cases à cocher cliquables** dans l'aperçu (enregistrées immédiatement si le fichier était propre).
- `Entrée` continue la liste (et ajoute `[ ]` après une tâche), `Ctrl+Entrée` coche/décoche la ligne courante.
- Vue **Tâches** (`Ctrl+Maj+X`) : toutes les `- [ ]` du projet, groupées par fichier et par titre, avec progression,
  filtres À faire / Toutes / Terminées et ajout rapide dans `TODO.md` (ou le fichier de votre choix).
- Recherche plein texte dans le projet (`Ctrl+Maj+F`), avec casse, mot entier, regex et filtre de fichiers.

### Sections (titres `#` à `######`)
- Vue **Sections** (`Ctrl+Maj+O` pour y sauter) : l'arbre des titres du fichier Markdown ouvert (`#`, titres soulignés
  `===`/`---` et `<h1>`…`<h6>`), avec l'avancement des tâches de chaque section et la section où se trouve le curseur.
- Organiser : monter / descendre, **glisser-déposer** (la section prend le niveau de la cible, sous-sections comprises),
  remonter / descendre d'un niveau (H2 → H1, H2 → H3…), renommer, supprimer, copier, créer une section ou une sous-section.
  Chaque modification passe par l'éditeur : `Ctrl+Z` l'annule.
- Ajouter une tâche **dans une section** : bouton ☑ de la vue Sections, sélecteur de section dans la vue Tâches,
  ou `+` au survol d'un titre dans la vue Tâches.
- Le fil d'Ariane affiche la section courante ; dans l'aperçu, la flèche à gauche d'un titre replie / déplie sa section.

### Terminal et commandes
- Terminal par projet : `cd`, historique (↑/↓), complétion des noms de fichiers (`Tab`), couleurs ANSI,
  `Ctrl+C` pour arrêter, `Ctrl+L` pour effacer. Quand un processus attend une saisie, la ligne tapée lui est envoyée.
- Vue **Commandes** : enregistrez vos commandes (nom, ligne de commande, sous-dossier) et lancez-les en un clic,
  ou depuis n'importe où avec `Ctrl+Maj+B`.
- **Détection automatique** (racine et sous-dossiers de premier niveau) : scripts `package.json` (npm/yarn/pnpm/bun),
  `composer.json`, Laravel `artisan`, Symfony, Django, Python (pip/uv/poetry/pytest), Go, Rust (cargo), .NET, Maven,
  Gradle/Android, Flutter/Dart, Ruby/Rails, Docker / docker compose, Makefile, justfile, Deno, scripts `.sh`/`.bat`/`.ps1`.
- Chaque commande tourne dans sa propre session (liste à droite du terminal) : relancer ⟳, arrêter ■, fermer.
  Les processus continuent si vous rechargez la page.

### Git
- Branche, ↓ en retard / ↑ en avance, fichiers modifiés (indexer, retirer, annuler, voir le diff), historique des commits.
- Commit (`Ctrl+Entrée` dans le message), **Commit + Push**, Pull, Push (crée la branche amont si besoin), Fetch, Synchroniser.
- Changement / création de branche, ajout ou modification d'un remote (« connecter un dépôt »), `git init`.
- **Tout synchroniser** (barre de titre) : `pull --ff-only` puis `push` sur tous les projets git, en toute sécurité
  (aucun merge automatique ; les projets sans branche amont sont ignorés).

L'authentification git utilise votre configuration habituelle (clé SSH ou gestionnaire d'identifiants). Dash ne demande
jamais de mot de passe : si une opération échoue pour cette raison, configurez SSH ou `git config --global credential.helper`.

## Raccourcis

| Action | Raccourci |
|---|---|
| Ouvrir un fichier | `Ctrl+P` |
| Palette de commandes | `Ctrl+Maj+P` / `F1` |
| Changer de projet | `Ctrl+R` |
| Lancer une commande | `Ctrl+Maj+B` |
| Enregistrer / tout enregistrer | `Ctrl+S` / `Ctrl+Maj+S` |
| Cocher une tâche | `Ctrl+Entrée` |
| Aperçu Markdown | `Ctrl+Maj+V` |
| Terminal | ``Ctrl+` `` ou `Ctrl+J` |
| Barre latérale | `Ctrl+B` |
| Aller à une section | `Ctrl+Maj+O` |
| Explorateur / Recherche / Git / Tâches | `Ctrl+Maj+E` / `F` / `G` / `X` |
| Fermer l'onglet / Nouveau fichier | `Alt+W` / `Alt+N` |
| Aller à l'onglet n | `Alt+1…9` |

## Options (ligne de commande)

```
DashLite [-port 4777] [-no-browser] [-browser app|default] [-data DOSSIER] [-version]
```

- `-no-browser` : serveur seul (ouvrez `http://127.0.0.1:4777`), qui reste actif jusqu'à `Ctrl+C`.
- `-browser default` : ouvrir dans le navigateur par défaut plutôt qu'en fenêtre d'application.
- `-data` (ou la variable `DASHLITE_DATA`) : dossier de configuration.

Le journal est écrit dans `dashlite.log`, dans le dossier de configuration.

## Sécurité

Dash exécute des commandes sur votre machine : il n'écoute que sur `127.0.0.1`, exige un jeton aléatoire (généré à chaque
démarrage et injecté dans la page) pour chaque appel d'API, refuse les requêtes dont l'en-tête `Host` n'est pas local
(protection contre le DNS rebinding) et confine les opérations sur les fichiers au dossier de chaque projet.

## Compiler

Go 1.22+ :

```bash
./build/build.sh                  # → dist/ : Windows x64/ARM64, Linux x64/ARM64 + SHA256SUMS
VERSION=1.2.0 ./build/build.sh    # avec un numéro de version précis
go run . -no-browser              # développement
```

```
main.go         démarrage, instance unique, fenêtre, arrêt à la fermeture
update.go       mises à jour automatiques (GitHub Releases, SHA-256, remplacement, redémarrage)
server.go       HTTP, jeton, API projets/réglages
fsapi.go        fichiers, recherche, tâches Markdown
runs.go         terminal et sessions de commandes (flux SSE)
git.go          opérations git
detect.go       détection des commandes par type de projet
proc_*.go       spécificités Windows / Unix
web/            interface (HTML/CSS/JS sans dépendance, intégrée dans l'exécutable)
                highlight.js = coloration syntaxique, sections.js = gestion des sections
build/          script de compilation, icônes, ressources Windows (icône, manifeste)
.github/        publication automatique des Releases
```
