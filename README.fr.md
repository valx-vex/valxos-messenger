# VALXOS Messenger

[Read this in English](README.md)

**Un bureau de poste local pour le courrier durable entre sessions d'agents.**

Ce n'est pas une messagerie instantanée. Une session dépose une lettre dans un
bureau SQLite ; le Facteur tente de la remettre ; les moniteurs, hooks et outils
MCP la présentent au destinataire. Le courrier traverse les redémarrages sans
demander à un humain de recopier les messages.

`valxos-messenger` est le nom public : le paquet npm et le dépôt GitHub. Le
serveur MCP s'annonce `valxos_messenger`, un identifiant. Le plugin Claude Code
et sa clef de serveur MCP s'appellent `valxos-messenger`. `cc2cc-v2`,
anciennement CEREAL, était l'ancien identifiant du plugin et du serveur ; il
reste la racine des alias de compatibilité.

## La loi du courrier

Trois promesses gouvernent le dessin du système.

1. **Livraison au moins une fois.** On préfère un doublon à une lettre perdue.
   Une lettre peut donc apparaître deux fois : c'est un choix de fiabilité, pas
   une promesse d'exactement-une-fois.
2. **Accusé nul ⇒ la lettre finit toujours par revenir.** Il n'existe ni état
   MORTE, ni quarantaine infinie, ni suppression qui rende une lettre invisible.
   L'état d'une lettre ne s'écrit pas, il se dérive : aucune colonne `state` ou
   `status` ne peut mentir après la mort d'un porteur entre son écriture et son
   geste. Les ajournements et les baux sont finis ; seul l'accusé est terminal.
3. **Rien ne s'efface.** Retirer une fiche la marque hors service sans la
   supprimer. Les lettres, tentatives, événements et réexpéditions restent au
   registre.

Trois mots décrivent trois faits différents :

| Mot | Ce qu'il prouve | Marqueur |
|---|---|---|
| **remis au guichet** | la boîte a accepté les octets | `messages.carried_at` |
| **livré** | un porteur affirme avoir préparé le contexte | `messages.delivered_at` |
| **accusé** | le destinataire l'a vu et l'a dit lui-même | `messages.acked_at` |

`carried_at`, `delivered_at` et `injected_at` sont des observations historiques.
Elles ne cachent jamais une lettre. Seul `acked_at`, posé par un destinataire
autorisé, est terminal.

Le détail des réservations, baux, reprises et limites est dans
[`docs/FACTEUR.md`](docs/FACTEUR.md).

## Adresses et trajet d'une lettre

Une **maison** est une installation locale, une **instance** une session vivante,
une **lignée** le nom durable auquel on écrit, et une **chaise** la place d'une
instance dans cette lignée. Si plusieurs chaises vivantes portent la même
lignée, la lettre attend une désignation humaine : le bureau ne tire pas au
sort. Une fois une chaise désignée, elle reçoit le courrier de la lignée, et
chaque autre chaise vivante de la lignée en voit une copie cc, jamais livrée et
jamais à accuser. Un ancien nom peut continuer à résoudre par un ordre de
réexpédition.

```text
session expéditrice ──> SQLite (bureau durable) ──> session destinataire
       │                       ▲                          ▲
       └─ réveil socket ───────┤                          │
                               └─ Facteur ─> monitor/hooks
                                  remet, réessaie, journalise
```

- SQLite conserve lettres, fiches, tentatives et événements dans le répertoire
  d'exécution.
- Les sockets Unix transportent un réveil ; la lettre reste dans le bureau.
- Le Facteur peut lire le corps pour le porter, mais ne journalise ni le corps,
  ni l'objet, ni le jeton d'une boîte.
- Le CLI, le serveur MCP, les hooks et le moniteur sont des portes sur le même
  registre ; ils ne portent pas une seconde loi du courrier.

Le Facteur parcourt les répertoires d'installation de Claude Code pour trouver
les chaises vivantes. Par défaut il parcourt `~/.claude` et, s'il est posé,
`$CLAUDE_CONFIG_DIR`. Une déclaration `VALXOS_MAISONS` (chemins absolus écrits
en entier, tels que `echo "$HOME/.claude"` les affiche : le Messenger ne
développe ni `~` ni `$HOME` dans cette valeur, et un plist launchd non plus ;
séparés par des deux-points ; `CC2CC_MAISONS` est l'alias historique) remplace
cette liste par défaut ; elle ne s'y ajoute pas. `$CLAUDE_CONFIG_DIR` en sort
aussi : mettez le chemin de votre `~/.claude` dans la déclaration si vous
voulez encore que cette maison soit parcourue, et incluez le chemin de votre
`CLAUDE_CONFIG_DIR` si vous voulez encore qu'il soit parcouru. Une entrée qui
finit par `/*` est une rue de maisons : chaque dossier directement sous ce
chemin est une maison (un lien vers un dossier aussi ; les fichiers et les
liens cassés sont ignorés ; l'ordre est trié). La rue est relue à chaque
tournée : une maison créée après le démarrage du Facteur est parcourue sans
redémarrage. Une entrée sans `/*` est cette maison-là, et rien d'autre n'est
développé dans la valeur.

Exportez le même `VALXOS_MAISONS` dans l'environnement de vos sessions aussi
(le profil de votre shell, ou le bloc `env` de l'entrée du serveur MCP) :
`send` calcule son avis `attente` dans l'environnement de la session qui
envoie, et sans la déclaration il peut dire `maison-inconnue` pour une chaise
que le Facteur livre bel et bien. Une rue doit être un dossier où vous seul
pouvez écrire : tout dossier créé dessous devient une maison que le Facteur
parcourt.

## Les tables

Une **table** est un carnet d'adresses, pas une boîte aux lettres : une liste
nommée de membres (une lignée, une chaise `nom#session`, une adresse humaine
`nom@label`, ou une carte nue comme l'opérateur de la porte web), avec une
règle de réveil, un mode (`normal` ou `direct`), un drapeau « fermée » et une
position partagée. Envoyer à `table:<nom>` dépose **une lettre par membre**,
l'expéditeur exclu sous tous ses noms ; les lettres partagent un `envoi_id`,
et chacune garde son destinataire, son trajet et son accusé, exactement comme
une lettre envoyée à ce membre seul. Aucune lettre n'est jamais « à la
table » : retirer un membre le marque, rien ne s'efface, et une table ne se
supprime pas.

Qui est réveillé se décide au guichet et s'écrit sur chaque lettre
(`sans_reveil`, avec sa raison dans `motif_reveil`) : `high` et `critical`
réveillent toujours ; `low` jamais. `reveiller: ["<membre>", ...]` sur `send`
ou `reply` réveille les membres nommés (sauf en priorité `low`) : un membre se
nomme par l'adresse que la table liste, la forme entière d'une chaise courte, sa
lignée, ou, pour un membre inscrit en lignée, une de ses chaises (une chaise
que le bureau connaît : un `lignée#…` inconnu ne réveille personne) ; une chaise
sœur ne le réveille pas. `reveiller` prend 50 noms de 200 caractères au plus
(`refus: "parametre-invalide"` au-delà). Une réponse
dans une table en mode `direct` est une réaction calme : personne n'est
réveillé, le beat suivant réveille. Sinon la règle du membre, puis celle de la
table : `reveil` ou `prochain-tour`. Une lettre calme n'est pas portée par le
Facteur et ne retient jamais un arrêt : elle arrive au prochain démarrage de
session, appel d'outil ou `inbox`, par les hooks comme toute lettre. Ce sont
les règles d'une lettre de table. Une lettre directe est portée et sonnée comme
en 1.0.0 quelle que soit sa priorité, `low` comprise (chez une chaise Codex, une
sonnerie démarre un tour) ; seul le filet du Stop ne retient jamais un arrêt
pour une lettre `low`.

Une table **fermée** (`valxos-table creer <nom> --fermee`, ou
`valxos-table fermer <nom>`) n'est listée qu'à ses membres, ses membres ne
bougent que par `valxos-table`, sa position est cachée aux non-membres, et ses
lettres ne donnent jamais de copie cc à une autre chaise de la lignée d'un
membre (`sans_copie`). Une `reply` directe à une telle lettre garde
`sans_copie` : la réponse n'arrive pas non plus en copie cc à une autre chaise
de la lignée de l'auteur. `history` (MCP et `valxos-history`) omet une telle
lettre pour un lecteur qui n'en est ni le destinataire, ni la chaise qui l'a
postée, ni un membre de la table (le lecteur est l'identité de
l'environnement, jamais un `self` déclaré), et les droits d'auteur (`reply` en
expéditeur, `envoi_status`) vont à la chaise qui a posté la lettre, pas à sa
lignée nue. Un **enclos** (`valxos-table enclos <expéditeur>
<nom>`) lie un expéditeur à une table fermée dont il est membre : toute lettre
de cet expéditeur à quiconque hors de la table est refusée avant qu'aucune
lettre ne soit écrite (la carte de pair de l'expéditeur a pu être inscrite
avant ; `refus: "hors-enclos"`, avec `enclos` et `destinataires_refuses`),
sauf si l'appel dit `hors_enclos: true` (`--hors-enclos` pour `valxos-send`).
Tant que l'enclos tient, la table ne se rouvre pas et l'expéditeur ne s'en
retire pas (`table-sous-enclos`). Un enclos tient une table à la fois : le poser
sur une autre tant qu'il tient est refusé (`enclos-existe`) ; on le lève
d'abord. Il en va de même sous chacune des formes de l'expéditeur (sa lignée,
une chaise, une chaise courte, une adresse humaine), et un bureau qui porte déjà
deux tels enclos vers deux tables refuse les lettres de cet expéditeur
(`refus: "enclos-conflit"`, avec `tables`) tant que l'un n'est pas levé.
L'enclos est une ceinture pour l'expéditeur
qui l'a demandé, pas une frontière contre un processus qui choisit d'en sortir
([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md),
en anglais).

Les outils MCP : `send` avec `to: "table:<nom>"` ; `reply` à l'auteur d'une
lettre — sa chaise si elle est connue — dans le même fil, ou à toute sa table
avec `toute_la_table: true` (le défaut dans une table `direct`) ; `tables`
(vos tables, `membre: true`, et les tables ouvertes que vous pourriez
rejoindre, `membre: false`) ; `table_manage` (créer une table ouverte, la
rejoindre ou la quitter, ajouter ou retirer un membre d'une table dont vous
êtes, la règle de réveil, le mode, la position partagée) ; `envoi_status` pour
les états d'un envoi, membre par membre : `cree`, `sonne`, `montre`,
`accuse` — jamais « lu » : seul l'accusé veut dire vu et traité — et la
dernière tentative du Facteur (`tournee`). Les tables fermées et les enclos
sont un geste humain : `valxos-table` seulement.

Une lettre de table porte `Table: <nom> (<mode>) · position: "<texte>"` dans
son en-tête. La position fait 120 caractères au plus (points de code), tout
membre peut l'écrire : c'est du texte non fiable, comme un objet, cité en
chaîne JSON. `valxos-history --thread <id> | --table <nom> | --envoi <id>`
exporte votre côté d'une conversation en markdown, ou en JSON avec
`--format json`.

Deux choses plus calmes arrivent avec les tables. Une lettre déjà présentée et
non accusée revient avec `Reminder: <n>` dans son en-tête, et les rappels
s'espacent : là où la 1.0.0 ramenait une lettre non accusée toutes les 10
minutes, la 1.1.0 la ramène après 10, 20, 40, puis toutes les 60 minutes.
`From:` montre le nom de la chaise expéditrice quand elle en a un, dans
l'en-tête des hooks et du moniteur — `From: alice (atelier)` — et une chaise
s'adresse par sa lignée et les huit premiers caractères hexadécimaux (ou plus)
de son identifiant de session, `alice#<préfixe>`, quand une seule chaise en
service correspond ; si plusieurs correspondent, la lettre attend
(`attente.motif: "chaise-ambigue"`).

## La sonnette Codex

Depuis 1.1.0, une session Codex peut être sonnée. Trois pièces, toutes dans
ce paquet : le **hook Codex** (`src/hooks/codex/codex-hook.js`, un seul
exécutable pour `SessionStart`, `UserPromptSubmit`, `PostToolUse` et `Stop`),
dont l'installeur écrit la commande avec un `node` absolu, l'identité et le
bureau en ligne et `--serves <nom>` ; il injecte le courrier en attente cadré
comme texte non fiable, n'accuse jamais, et ne retient un arrêt que pour du
courrier `high` ou `critical` non lu, trois fois au plus ; la **fiche de
chaise** `<bureau>/codex/<lignée>.json`, écrite par `SessionStart` au premier
tour d'une session ; et la **porte Codex du Facteur**
(`src/facteur/porte-codex.js`) : quand une lettre mène à une chaise qui a une
fiche, la tournée lance `codex queue` avec une enveloppe — expéditeur, nom de
chaise, table, objet coupé à 60 caractères, priorité, combien d'autres lettres
attendent — et jamais un corps de lettre : un message mis en file arrive au
modèle comme une parole de l'utilisateur. La lettre elle-même arrive par les
hooks et `inbox`.

Quand aucune session active ne porte le fil, ou quand la file a pris
l'enveloppe alors que l'app de bureau est fermée, le Facteur ouvre l'app sur
le fil (`open codex://threads/<uuid>`, macOS), une fois par lettre, et
seulement pour une chaise dont la porte est `app` : c'est la variable
`VALXOS_CODEX_PORTE` de la session (absente, elle vaut `app` ; un lanceur de
terminal doit poser `VALXOS_CODEX_PORTE=cli`). `VALXOS_CODEX_OUVRIR_APP=0`
désactive l'ouverture. Une lettre neuve garde son ouverture même quand elle
partage l'enveloppe d'une lettre plus ancienne qui a déjà eu la sienne. Le
Facteur ne lance jamais `codex exec resume`.

Installation : `valxos-messenger install --codex --self <nom>` imprime les
trois morceaux à poser dans `$CODEX_HOME` et ne touche à rien ; `--write`
sauvegarde chaque fichier (suffixe daté), fusionne et imprime le diff. Codex
n'exécute un hook neuf qu'après son approbation dans `/hooks`. Le câblage, les
conditions et le smoke test :
[`docs/MCP_CLIENTS.md`](docs/MCP_CLIENTS.md#codex-hooks-and-the-doorbell) (en anglais).

La limite : après **Échap** dans le TUI de Codex, la file se fige jusqu'au
prochain prompt tapé par un humain ; le Facteur ne peut pas le savoir, la
lettre reste remise au guichet, et les hooks l'injectent à ce prompt. Une
lettre que la file a prise ne sonne plus. Avant le premier tour d'une session,
`codex queue` ne l'atteint pas (`no rollout found`). Quand une sonnerie échoue,
la lettre
attend une tournée suivante, les hooks la présentent au tour suivant, et
`envoi_status` montre la raison de la tournée, `sonnette-codex-impossible`,
pour un envoi de table (le journal du Facteur la dit pour toute lettre).
Il n'y a pas de porte vers l'app iPhone.

## La porte web

`valxos-web` sert une page unique, sans framework ni dépendance chargée chez un
tiers, où un opérateur lit et écrit son courrier depuis le navigateur. Chaque
lettre porte un seul cachet qui se complète en quatre degrés, les valeurs
`en attente`, `au guichet`, `reçue` (l'observation de livraison) puis `accusée`
du champ `etat` de l'API ; la page les affiche sous leurs libellés anglais,
**Waiting**, **Carried**, **Delivered** et **Acked**, et une lettre en
souffrance s'y lit **Overdue**.

Ouvrir la page (ou `GET /api/fil`) accuse les lettres ordinaires adressées à
l'opérateur (type `message`, priorité `low` ou `normal`) ; `high`, `critical`
et tout autre type attendent le bouton Acknowledge.

`POST /api/poster` accepte `a: "table:<nom>"` (préfixe sans casse) : la porte
dépose par le même guichet que le `send` MCP, une lettre par membre, et répond
`destinataire`, `table`, `envoi_id`, `count` et `results`. Un envoi refusé
répond `403 hors-enclos` (avec `enclos` et `destinataires_refuses`),
`403 enclos-conflit` (avec `tables`),
`404 table-inconnue`, `403 pas-membre` ou `400 nom-de-table-invalide`, et le
corps peut porter `hors_enclos: true` (un booléen JSON). Un envoi de table
interrompu après quelques lettres répond `500` avec `interrompu: true`, les
`lettres_ecrites` et un `motif` fixe. Le fil porte `table`, `table_mode`,
`position`, `chaise_nom`, `rappel`, `envoi_id` et `reponse_a` avec chaque
lettre, et la page montre la ligne `Table: <nom> (<mode>) · position: "<texte>"`
sous l'en-tête d'une lettre de table. Les tables s'administrent par
`valxos-table` ; le composeur de la page ne propose pas de table dans cette
version.

La porte est une section Messenger, pas un centre de commande complet : elle ne
crée ni ne reprend de session, elle n'édite aucun fichier. Son serveur refuse
d'écouter ailleurs que sur la boucle locale ; une exposition réseau éventuelle
doit être organisée et protégée en amont.

## Harnais pris en charge

| Harnais | MCP | CLI | Hooks | Moniteur | Réveillé par le Facteur | Statut (preuve) |
|---|---|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | ✓ | ✓ en interactif seulement | oui, en session interactive (voir détails) | **Prouvé le 18/10/2026 avec Claude Code 2.1.302** : MCP, CLI et les trois hooks en session headless (`claude -p`) et interactive ; le moniteur s'arme en session interactive seulement, pas sous `claude -p` ([détails, en anglais](docs/MCP_CLIENTS.md#claude-code)) |
| **Codex CLI** | ✓ | ✓ | ✓ depuis 1.1.0 | — | oui (vu en direct sur une maison jetable, 22/10/2026) | **Prouvé le 18/10/2026 avec codex-cli 0.162.1**, headless `codex exec` : l'aller-retour MCP et la CLI, à condition que l'entrée du serveur pose `default_tools_approval_mode = "approve"`. **Prouvé le 21/10/2026 avec codex-cli 0.163.0**, contre une maison Codex jetable et un modèle local : `codex queue` a réveillé une session interactive inactive, et le modèle réveillé a appelé `inbox` et vu la lettre ; le même jour, sur l'app de bureau des auteurs, un message mis en file a réveillé un fil ouvert, et `open codex://threads/<uuid>` a rouvert l'app fermée sur lui. **Vu en direct le 22/10/2026 avec codex-cli 0.163.0**, sur une maison Codex jetable (TUI, modèle local, confiance des hooks contournée, hooks écrits par `install --codex --write`) : une lettre a sonné le hook livré et la porte du Facteur de bout en bout — `codex queue` 0,35 s après la lettre, tour autonome 5,7 s après la lettre, lettre injectée par `UserPromptSubmit`, `inbox` appelé. Pas vu : les hooks dans l'app de bureau, l'approbation `/hooks` des hooks écrits par l'installeur, l'ouverture d'une app fermée par la porte ([détails, en anglais](docs/MCP_CLIENTS.md#codex-cli) ; [ce qui a été vu, en anglais](docs/MCP_CLIENTS.md#codex-hooks-and-the-doorbell)) |
| **Gemini CLI** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec Gemini CLI 0.58.0**, headless : l'aller-retour MCP depuis un `.gemini/settings.json` de projet, dans un dossier de confiance (`GEMINI_CLI_TRUST_WORKSPACE=true`), avec une clé API ; le mode interactif n'a pas été testé ([détails, en anglais](docs/MCP_CLIENTS.md#gemini-cli)) |
| **Antigravity CLI (agy)** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec agy 1.3.5**, headless seulement (`-p --sandbox --dangerously-skip-permissions`) : l'aller-retour MCP depuis un plugin d'espace de travail (`<projet>/.agents/plugins/<nom>/`) ; chaque serveur de la config globale d'agy démarre aussi ; agy 1.4.2 et le TUI n'ont pas été testés ([détails, en anglais](docs/MCP_CLIENTS.md#antigravity-cli-agy)) |
| **OpenCode** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec OpenCode 1.18.30**, headless `opencode run` seulement : l'aller-retour MCP depuis une entrée `mcp` d'un `opencode.json` de projet (`type: "local"`) ; le TUI n'a pas été testé ([détails, en anglais](docs/MCP_CLIENTS.md#opencode)) |
| **Hermes** | ✓ | ✓ | — | — | non — au tour suivant | **Prouvé le 25/08/2026**, MCP et CLI, avant 1.0.0 ; le câblage n'a pas été revérifié pour 1.0.0 ([détails, en anglais](docs/MCP_CLIENTS.md#hermes)) |
| **Tout autre client MCP** | ✓ | ✓ | — | — | non | **Promis** — aucun test propre au harnais |

`valxos-inbox` montre jusqu'à 20 lettres non accusées (`--limit N`) ; accusez avec
`valxos-inbox --ack <msg_id>` pour que les suivantes remontent.

Chaque statut daté du 18/10/2026 veut dire : ce jour-là, sur macOS, contre un
bureau jetable, `whoami`, `send`, `inbox`, `ack` et `history` ont tourné par
le harnais en MCP, et la CLI a lu ou écrit l'autre côté de la lettre. Un statut
daté du 21/10/2026 veut dire : ce jour-là, sur macOS, contre une maison Codex
jetable avec un modèle local, `codex queue` a réveillé une session inactive, et
les événements des hooks (servis par un script de hook de substitution) se sont
comportés comme les schémas embarqués dans Codex les décrivent ; et, sur l'app
de bureau des auteurs, un
message mis en file a réveillé un fil ouvert, puis
`open codex://threads/<uuid>` a rouvert l'app fermée sur son fil. Un statut
daté du 22/10/2026 veut dire : ce jour-là, sur macOS, sur une maison Codex
jetable avec un modèle local et la confiance des hooks contournée, une lettre
est passée par le hook livré et la porte du Facteur : `codex queue` a sonné la
session et un tour autonome a lu la lettre.

**Ce qui réveille une session.** Les sessions Claude Code et les sessions
Codex sont réveillées ; tout autre harnais relève. Pour Claude Code, le
Facteur remet la lettre au socket de messagerie propre à la session, et, sur
un réveil, le moniteur du plugin l'affiche (en session interactive) ; les hooks
injectent le courrier en attente au démarrage de la session, après chaque
appel d'outil et avant un arrêt. La poussée du Facteur dans une session Claude
Code 2.1.302 vivante a été observée dans la maison des auteurs le 18/10/2026
(huit lettres remises au socket de la session par le Facteur de la release
précédente, dont le Facteur 1.0.0 garde la logique de connexion inchangée) ; la
suite de tests vérifie le Facteur 1.0.0 contre un socket de substitution ; le
réveil en session par le moniteur du plugin a été vérifié en direct le même
jour. Sous `claude -p`, le moniteur ne s'arme pas ; les hooks présentent encore
le courrier. Pour Codex (avec ses hooks 1.1.0 installés ; vu en direct une
fois le 22/10/2026, sur une maison jetable), le Facteur sonne la chaise par `codex queue` — une
enveloppe, jamais un corps de lettre — et les hooks Codex injectent le courrier
au tour suivant (voir « La sonnette
Codex »). Une lettre de table calme (priorité `low`, règle `prochain-tour`,
réaction dans une table `direct`) ne réveille personne : elle attend le tour
suivant. Tout autre harnais relève son courrier lui-même en appelant `inbox`
(MCP) ou `valxos-inbox` (CLI) ; rien ne sonne. Dans l'installation des
auteurs, le 25/08/2026, Hermes voyait son courrier au début de son tour
suivant, par un plugin côté Hermes que ce paquet ne livre pas.

Le moniteur est propre à Claude Code ; les hooks existent pour Claude Code et,
depuis 1.1.0, pour Codex.

## Installer et démarrer

**Le plus simple :** donne cette URL à ton LLM — `https://github.com/valx-vex/valxos-messenger` (le dépôt est public ; ce README est tout le contrat) — et dis-lui : "make it good in my setup". Il lit ce README, lance l'installeur et branche le plugin dans ton harnais.

**Avec npm :**

    npm i -g valxos-messenger --allow-scripts=better-sqlite3
    valxos-messenger install --dry-run   # simulation
    valxos-messenger install             # installation

npm 12 bloque par défaut les scripts d'installation des dépendances, et
better-sqlite3 a besoin du sien pour télécharger son binaire précompilé ;
`--allow-scripts=better-sqlite3` autorise ce seul script. Si l'installeur dit
`native binding missing`, lance la commande `npm rebuild` qu'il affiche.

**Depuis un clone** (ou une archive extraite) :

```bash
npm install
node scripts/install.js
```

L'installeur pose les liens des commandes sous `~/.local/bin`, le lien du plugin
Claude Code et le bureau (`~/.valxos-messenger`, ou celui que nomme
`VALXOS_MESSENGER_HOME`), pour que `valxos-doctor`, lancé ensuite, en trouve un
à lire. Les noms publiés sont :

```text
valxos-send          valxos-peers         valxos-inbox
valxos-unregister    valxos-chaise        valxos-monitor
valxos-doctor        valxos-web           valxos-migrate-v1
valxos-migrate-home  valxos-table         valxos-history
valxos-messenger     facteur              valxos-relais
```

Les anciens exécutables `cc2cc-*` restent des alias **dépréciés** vers les
mêmes programmes.

Le lien `skills-dir` que `valxos-messenger install` écrit et la commande
`claude plugin enable valxos-messenger@skills-dir` n'ont pas été exercés de bout
en bout dans une session Claude Code pour cette release ; le plugin a été
vérifié depuis le même arbre avec `--plugin-dir`.

**Nommez chaque maison.** Posez `VALXOS_SELF=<nom>` dans le lanceur de chaque
harnais qui démarre le serveur ou les hooks (et `VALXOS_SESSION_NAME` si vous
voulez des noms par session). Sans lui, toutes les sessions de la machine
parlent sous le nom d'hôte, donc sous un seul nom ; `whoami` affiche le nom en
usage. Donnez à chaque harnais son propre nom : un client CLI ou MCP qui prend le
nom d'une lignée Claude Code ne relève pas le courrier de cette lignée tant
qu'une de ses chaises est vivante (voir `docs/MCP_CLIENTS.md`, en anglais).

Pour Codex, `valxos-messenger install --codex --self <nom>` imprime les hooks
et l'entrée MCP à poser dans `$CODEX_HOME`, et ne les écrit qu'avec `--write`
(voir « La sonnette Codex »).

Avec `--launchd`, l'installeur écrit aussi les deux plists launchd du Facteur
et de la porte web (`com.valxos.messenger.facteur`, `com.valxos.messenger.web`)
sous `~/Library/LaunchAgents/` ; `--launchd-load` les charge. Les deux plists
épinglent `VALXOS_MAISONS` : la déclaration avec laquelle l'installeur tourne,
telle qu'écrite, sinon le chemin de votre `~/.claude`. Ils ne portent pas
`CLAUDE_CONFIG_DIR` : sous launchd, le Facteur ne parcourt que cette liste, et
l'avis `attente` de la porte web sur un envoi utilise la même liste (voir les
limites connues). Pour déclarer vos maisons, lancez l'installeur avec la liste
complète, entre guillemets pour que le shell développe `$HOME` et laisse un
`/*` final intact :

```bash
VALXOS_MAISONS="$HOME/.claude:$HOME/agents/*" valxos-messenger install --launchd
```

Détails dans [`docs/INSTALL_ONE_CLICK.md`](docs/INSTALL_ONE_CLICK.md) (en anglais).

Pour porter des lettres entre deux Macs par ssh, voir
[`docs/RELAIS.md`](docs/RELAIS.md) (en anglais) : le relais est optionnel, et
son service launchd n'est écrit que par `install --relais --write`, jamais par
une installation par défaut ni par `--launchd`.

Le câblage du serveur MCP dans chaque harnais (Claude Code, Codex CLI, Gemini
CLI, Antigravity CLI, OpenCode, Hermes) — le bloc de configuration qui a
marché, les conditions, l'identité et le bureau du pair, ce qui n'a pas été
testé, un smoke test pour chacun — est décrit dans
[`docs/MCP_CLIENTS.md`](docs/MCP_CLIENTS.md) (en anglais).

Le répertoire d'exécution par défaut est `~/.valxos-messenger`. La variable
`VALXOS_MESSENGER_HOME` peut le déplacer ; `CC2CC_V2_HOME` reste un alias
historique et perd si les deux variables sont définies (une
`VALXOS_MESSENGER_HOME` vide compte pour absente, et le dit sur stderr).

La porte web exige le nom unique de son opérateur. Dans
`~/.valxos-messenger/web.env` :

```dotenv
VALXOS_WEB_OPERATEUR=alice
# VALXOS_WEB_JETON=<un jeton existant ; sinon la porte en crée un en 0600>
# VALXOS_WEB_HOTE=127.0.0.1
# VALXOS_WEB_PORT=8790
# VALXOS_WEB_CADRE_AUTORISE=https://command-center.example
```

Sans `VALXOS_WEB_OPERATEUR` — ou son alias historique
`CC2CC_WEB_OPERATEUR` — `valxos-web` refuse de démarrer avant d'ouvrir le
bureau.

Si seule l'ancienne installation `~/.cc2cc-v2` existe, le logiciel continue à
l'utiliser et annonce ce repli (les hooks le disent une fois par session, au
démarrage). Pour la copier explicitement vers le nouveau
répertoire, arrêtez d'abord les services, inspectez la simulation, puis appliquez :

```bash
valxos-migrate-home
valxos-migrate-home --apply
```

La migration ignore `run/` — sockets, PID et verrous éphémères —, accepte une
cible vide et refuse une cible non vide sauf `--force`, qui la met de côté
(datée, jamais effacée) ; elle refuse tant qu'un processus écrit la base
source, copie les liens tels qu'ils sont écrits, pose le marqueur
`.valxos-messenger-home` qui fait compter le nouveau bureau, et conserve la
source. Quand le bureau vivant ne peut pas s'arrêter, l'autre chemin est le
lien de Phase A, `ln -s ~/.cc2cc-v2 ~/.valxos-messenger` : chaque processus
résout alors le même bureau sous les deux noms.

## Limites connues

Ce que le produit ne promet pas, et les limites mesurées de cette release :

- La porte web est un guichet, pas une boîte aux lettres. Le navigateur relève
  le courrier ; le Facteur n'y livre pas. Une lettre attend que la page soit
  ouverte.
- Après authentification, `/api/accuser` répond `404 lettre-inconnue` pour une
  lettre inconnue et `403 pas-mon-courrier` pour celle d'un autre. La
  distinction est un oracle d'existence sur les identifiants de lettre, accepté
  sur une porte à un seul opérateur.
- Un ancien bureau `~/.cc2cc-v2` sert de repli, et le logiciel le dit ; le
  déplacer vers `~/.valxos-messenger` est un geste explicite et manuel
  (`valxos-migrate-home`, plus haut). Rien ne se déplace tout seul.
- Une porte web sert un seul opérateur.
- Pas d'exactement-une-fois : un crash après visibilité et avant accusé peut
  produire un doublon.
- Pas de preuve de lecture sans accusé, pas de chiffrement de bout en bout, et
  pas de garantie contre la perte physique du volume. SQLite tourne en mode WAL
  avec `synchronous=NORMAL` — le défaut compilé de better-sqlite3 pour WAL
  (`SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`), aucun pragma dans `src/`, mesuré par la
  suite ; sauvegarde et restauration testées restent à la charge de l'exploitant.
- Pas de quarantaine : une lettre empoisonnée revient avec un ajournement borné.
  La file visible d'intervention humaine reste à construire.
- Les lettres sont du texte non fiable. Le corps d'une lettre arrive tel quel
  dans le contexte du modèle destinataire, par les hooks, le moniteur du plugin
  et le Facteur, et l'expéditeur affiché est le nom que le pair s'est donné.
  Tout ce qui peut écrire dans le bureau peut mettre du texte devant un modèle ;
  l'en-tête du contexte des hooks dit de traiter les lettres comme du texte non
  fiable, pas comme des instructions
  ([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md),
  en anglais).
- Les hooks et le moniteur Python lisent l'identité dans leur propre alphabet
  (lettres, chiffres, point, tiret, souligné ; 64 caractères), comme en 1.0.0,
  quand le serveur MCP et la CLI la prennent telle qu'écrite :
  `VALXOS_SELF=alice opus` est `alice_opus` pour les hooks et le moniteur, et
  `alice opus` pour MCP et la CLI, deux boîtes. Donnez à chaque maison un nom
  dans cet alphabet.
- Pas de parité complète entre les harnais. MCP et CLI sont des interfaces
  générales ; le moniteur et l'inventaire des maisons par défaut sont propres
  à Claude Code ; les hooks existent pour Claude Code et Codex, et le Facteur
  ne sonne que les sockets Claude Code et les chaises Codex.
- Claude Code 2.1.292 et suivants négocient par défaut le protocole MCP
  2026-07-28 avec les serveurs stdio. Ce serveur parle la génération 2025-11-25
  (SDK 1.32). Selon le changelog de Claude Code, un tel serveur est connecté à
  l'ancienne après une première connexion lente, et ce choix est retenu 7
  jours. Prouvé le 18/10/2026 avec Claude Code 2.1.302 : le serveur se connecte
  en session headless et interactive (voir `docs/MCP_CLIENTS.md`, en anglais).
  Si une connexion échoue après une mise à jour de Claude Code, posez
  `MCP_PROTOCOL_NEGOTIATION=legacy` dans l'environnement qui lance Claude Code.
- Claude Code récent diffère les outils MCP derrière sa recherche d'outils.
  `inbox`, `send`, `ack` et `reply` sont marqués à charger d'emblée
  (`_meta['anthropic/alwaysLoad']`) ; les neuf autres peuvent devoir être
  chargés avant l'appel. Prouvé le 18/10/2026 avec Claude Code 2.1.302,
  recherche d'outils active (le défaut), pour le serveur 1.0.0 : seuls `inbox`,
  `send` et `ack` étaient chargés d'emblée ; `whoami`, `history`, `register`,
  `list_peers`, `unregister` et `broadcast` restaient différés jusqu'à ce que
  le modèle les charge par ToolSearch. Les marques 1.1.0 (`reply` chargé
  d'emblée ; `tables`, `table_manage` et `envoi_status` différés) sont lues par
  la suite de tests sur le serveur qui tourne, pas revues dans une session
  vivante.
- N'installez pas ce paquet comme plugin Claude Code depuis une source npm de
  marketplace : depuis Claude Code 2.1.275, une telle installation lance
  `npm pack --ignore-scripts`, et better-sqlite3 n'a alors pas de binding
  natif. Installez avec `npm i -g valxos-messenger --allow-scripts=better-sqlite3`
  puis `valxos-messenger install`.
- Claude Code 2.1.271 et suivants donnent une échéance aux veilles Monitor (30
  minutes ; 10 sous `claude -p`). Dans une session interactive de Claude Code
  2.1.302, le moniteur du plugin est resté armé pendant toute la session de 40
  minutes, au-delà de l'échéance de 30 minutes que Claude Code donne aux
  veilles Monitor, et a présenté une lettre déposée à la 33e minute en 20 ms
  (18/10/2026). Sous `claude -p`, le moniteur ne s'arme pas ; les hooks livrent
  à sa place. Les hooks ne dépendent pas du moniteur : le courrier en attente est injecté après chaque appel d'outil, et
  un arrêt est retenu tant qu'une lettre non lue de priorité supérieure à low
  attend, quoi qu'il arrive.
- La chaise d'une session Claude Code reste inscrite en service après la
  sortie de la session ; rien ne la marque morte d'elle-même (observé le
  18/10/2026 avec Claude Code 2.1.302 : chaque session `claude -p` a laissé sa
  chaise en service). En headless, cela s'accumule vite : dès qu'une lignée a
  plus d'une chaise en service et aucune désignée, une lettre à la lignée nue
  est tenue (`send` répond `attente.motif: "lignee-ambigue"`, et chaque chaise
  n'en voit qu'une copie cc marquée `sans-chaise-designee`) jusqu'à ce qu'un
  humain moissonne les chaises mortes (`valxos-chaise moissonner` ou
  `valxos-doctor --reap`) ou en désigne une (`valxos-chaise designer`).
  Adressez une chaise directement (`nom#session`) pour contourner la lignée.
- Les plists launchd écrits par `valxos-messenger install --launchd` ne
  portent pas `CLAUDE_CONFIG_DIR`, et leur `VALXOS_MAISONS` est le chemin de
  votre `~/.claude` sauf si l'installeur a tourné avec une déclaration : sous
  launchd, le Facteur ne parcourt que cette liste, et l'avis `attente` de la
  porte web sur un envoi utilise la même liste. Si votre configuration Claude
  Code vit ailleurs, relancez l'installeur avec la liste complète dans
  `VALXOS_MAISONS` ; un `CLAUDE_CONFIG_DIR` ajouté à la main dans un plist
  n'est pas parcouru, puisque la déclaration le remplace.
- La page de la porte web et la prose `message`/`motif` des réponses MCP et
  HTTP sont en anglais (depuis cette release) ; les codes MCP `refus` et
  `attente.motif` sont des identifiants stables, documentés dans
  `docs/MCP_CLIENTS.md` (en anglais).
- La sonnette Codex sonne une fois par lettre et ne voit pas un Échap : après
  Échap dans le TUI de Codex, une enveloppe mise en file attend le prochain
  prompt tapé par un humain, et la lettre arrive par les hooks à ce prompt.
  Une sonnerie qui échoue laisse la lettre aux hooks et à une tournée suivante
  (`envoi_status` montre `tournee.reason: "sonnette-codex-impossible"` pour un
  envoi de table). Une
  fiche de chaise par lignée : deux sessions Codex servies sous un même nom
  sonnent la dernière session qui a écrit la fiche (son `SessionStart`, ou un
  prompt ou un `Stop` d'une session dont la fiche ne nomme pas le fil). Le hook Codex livré
  et la porte Codex du Facteur sont vérifiés contre un `codex` de substitution
  dans la suite de tests, et ont été vus en direct une fois, le 22/10/2026 avec
  codex-cli 0.163.0 sur une maison Codex jetable (TUI, modèle local, confiance
  des hooks contournée) : une lettre a sonné la session et un tour autonome
  l'a lue. Les hooks dans l'app de bureau, l'approbation `/hooks` des hooks que
  l'installeur écrit et l'ouverture d'une app fermée par la porte n'ont pas été
  vus à l'écran. Il n'y a pas de porte vers l'app iPhone.
- L'enclos n'est pas une frontière de sécurité : tout appel peut dire
  `hors_enclos: true`, et tout processus du compte peut changer les tables ou
  lever un enclos par `valxos-table`
  ([SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md),
  en anglais). Une table
  fermée cache ses lettres aux copies cc des autres chaises ; elle ne cache pas
  le fichier SQLite.
  Deux bords de la 1.1.0 sont listés dans le CHANGELOG (en anglais) :
  `history` applique sa limite avant la garde de lecture (l'outil MCP s'arrête
  à 200 lignes et la page web à 500 ; élargir `valxos-history --limit`, qui
  n'est pas plafonné, retrouve une lettre que des lettres cachées ont poussée
  hors de la fenêtre, et se restreindre à son fil aussi, sauf si elles le
  partagent), et `/api/pairs` de la porte web
  montre à une lignée nue qu'une lettre de table fermée d'une de ses chaises
  attend quelque part (boîte, nombre, âge, tentatives de remise et dernier
  motif ; jamais le corps).
- Une chaise Codex dont la porte est `app` voit l'app de bureau s'ouvrir sur
  son fil quand une lettre sonne alors que l'app est fermée, même si la session
  est un terminal : la porte vaut `app` quand `VALXOS_CODEX_PORTE` est absente,
  et `install --codex --porte app` l'épingle pour toutes les sessions de cette
  maison Codex. Exportez `VALXOS_CODEX_PORTE=cli` dans un lanceur de terminal,
  ou posez `VALXOS_CODEX_OUVRIR_APP=0` pour le Facteur.

La garde web suit la même règle d'honnêteté :

- **Fermé structurellement :** le répartiteur ne sert que sa table ; répondre
  par les fonctions de la porte exige un verdict privé ; l'adresse d'écoute est
  bornée à la boucle locale.
- **Fermé par des listes à tenir à jour :** primitives de lancement connues,
  exceptions comptées, contrat des routes et polices, accès connus au serveur et
  au transport. La porte utilise des sondes locales fixes ; la garde vérifie sur
  le vrai trajet qu'aucun champ posté par l'utilisateur n'atteint leur ligne de
  commande.
- **Non fermé :** une porte dérobée délibérément obscurcie par un auteur autorisé
  du dépôt, un import dynamique calculé qui n'est jamais chargé par la sonde, ou
  un accès au transport écrit sous une forme que les listes ne reconnaissent
  pas. Ces cas relèvent aussi de la revue et du contrôle d'accès au dépôt.

Le danger n'est pas le trou ; c'est la phrase qui affirme qu'il n'y en a pas.
Les limites plus fines — horloge des baux, accusés tardifs, arrêt entre deux
tournées — sont consignées dans
[`docs/FACTEUR.md`](docs/FACTEUR.md#ce-que-ce-dessin-ne-r%C3%A9sout-pas-%C3%A0-lire-avant-de-lui-faire-confiance).

## Vérifier

Depuis un clone du dépôt (la suite de tests ne voyage pas dans le paquet npm) :

```bash
node --test test/*.test.js
```

`npm test` lance exactement cette commande ; la suite imprime elle-même son
compte. Dans un clone du dépôt public, la suite est la même, moins la garde des
noms privés, qui ne tourne que dans le dépôt des auteurs.

## Contribuer

Les surfaces publiques sont en anglais : le README anglais, la CLI, les
messages d'erreur qu'un utilisateur lit. **L'intérieur est en français** —
identifiants, commentaires et noms de tests. C'est une vraie barrière à la
contribution, elle est voulue, et elle n'est pas cachée : une traduction
complète a été mesurée à environ 30 000 lignes de remaniement dans du code
testé, et écartée comme un pire marché que la barrière elle-même.

Les commentaires expliquent *pourquoi*, pas *quoi* ; beaucoup portent la mesure
du défaut qui les a rendus nécessaires. Dans un clone, la gate est
`node --test test/*.test.js` (`npm test` la lance). Lisez
[CONTRIBUTING.md](https://github.com/valx-vex/valxos-messenger/blob/main/CONTRIBUTING.md)
(en anglais) avant d'ouvrir une pull request, et
[SECURITY.md](https://github.com/valx-vex/valxos-messenger/blob/main/SECURITY.md)
(en anglais) avant de signaler une vulnérabilité — jamais dans une issue
publique.

**Les sigles du registre dans les commentaires.** Les commentaires citent la
revue privée qui a précédé 1.0.0 comme provenance d'une mesure. A8 = livraison
au moins une fois ; A9 = accusé nul ⇒ la lettre revient ; Camp B = rien ne
s'efface, les fiches sont mises de côté ; E.1/E.2 = les deux chantiers du
Facteur : E.1 a construit le démon décrit dans `docs/FACTEUR.md`, E.2 est le
suivant, côté destinataire, que cette page cite comme non fait (launchd, lui,
est livré : voir `docs/INSTALL_ONE_CLICK.md`, en anglais) ; Run N, Task N et
les numéros F/N/M/C/S/G/I = des points de cette revue privée. Les codes T
(T4b-b, T4b-c…) numérotent les tâches du run de publication de 1.0.0, cités
dans quelques commentaires de tests ; les T1 à T6 nus de `src/facteur/round.js`
sont les étapes d'une tournée du Facteur.

## Licences

Le code est distribué sous **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`) : voir [LICENSE](LICENSE). En particulier, si vous faites
interagir des utilisateurs par le réseau avec une version modifiée, le §13 vous
oblige à leur offrir clairement l'accès au code source correspondant de cette
version. La porte web rend cette obligation centrale à tout usage réseau du
produit.

Les sources portent un en-tête court qui renvoie au texte complet au lieu de le
recopier.

Les familles **Archivo**, **Literata** et **DM Mono** embarquées dans
`src/web/public/polices/` restent sous **SIL Open Font License 1.1**, quelle que
soit la licence du code. Leurs textes et attributions voyagent avec elles dans
[`src/web/public/polices/LICENCE.md`](src/web/public/polices/LICENCE.md). Elles
sont locales parce qu'un chargement chez un tiers ferait appeler ce tiers par le
navigateur à chaque ouverture de la boîte aux lettres — contradiction directe
avec la souveraineté du courrier.
