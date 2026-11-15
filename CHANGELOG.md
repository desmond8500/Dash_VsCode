# Journal des versions

Chaque version publiée correspond à un tag `vX.Y.Z`. La section de ce fichier qui porte ce numéro
sert de notes de version : elle s'affiche dans Dash Lite (fenêtre *Mises à jour → Nouveautés*).

## [1.1.0] - 2026-11-15

### Ajouté
- **Mises à jour automatiques** depuis les Releases GitHub : téléchargement en arrière-plan, vérification SHA-256,
  remplacement de l'exécutable et bouton « Redémarrer » (modes automatique, notification ou désactivé).
- **Coloration syntaxique** dans l'éditeur (~25 langages) et surlignage de la ligne courante.
- **Vue Sections** pour les fichiers Markdown : arbre des titres `#`, déplacement, glisser-déposer, changement de niveau,
  renommage, suppression, ajout de sections et de tâches dans une section ; section courante dans le fil d'Ariane ;
  repli des sections dans l'aperçu.
- Vue Tâches : choix de la section où ajouter une nouvelle tâche.
- **Message de commit généré** (bouton ✨) à partir des modifications, hors ligne.
- Linux : ajout de Dash Lite au menu des applications.
- Version affichée dans la barre d'état.

### Modifié
- Seules les versions Windows et Linux sont publiées.

## [1.0.0] - 2026-11-15

### Ajouté
- Première version : un seul exécutable, fenêtre Chrome/Edge en mode application, projets de tout type,
  explorateur et éditeur, aperçu Markdown avec cases à cocher, vue Tâches, recherche, terminal par projet,
  commandes enregistrées et détectées automatiquement, git (commit, push, pull, branches, remote, synchronisation globale).
