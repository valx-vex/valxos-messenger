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
`CLAUDE_CONFIG_DIR` si vous voulez encore qu'il soit parcouru.

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

La porte est une section Messenger, pas un centre de commande complet : elle ne
crée ni ne reprend de session, elle n'édite aucun fichier. Son serveur refuse
d'écouter ailleurs que sur la boucle locale ; une exposition réseau éventuelle
doit être organisée et protégée en amont.

## Harnais pris en charge

| Harnais | MCP | CLI | Hooks | Moniteur | Réveillé par le Facteur | Statut (preuve) |
|---|---|---|---|---|---|---|
| **Claude Code** | ✓ | ✓ | ✓ | ✓ en interactif seulement | oui, en session interactive (voir détails) | **Prouvé le 18/10/2026 avec Claude Code 2.1.302** : MCP, CLI et les trois hooks en session headless (`claude -p`) et interactive ; le moniteur s'arme en session interactive seulement, pas sous `claude -p` ([détails, en anglais](docs/MCP_CLIENTS.md#claude-code)) |
| **Codex CLI** | ✓ | ✓ | — | — | non — relève par `inbox` | **Prouvé le 18/10/2026 avec codex-cli 0.162.1**, headless `codex exec` : l'aller-retour MCP et la CLI, à condition que l'entrée du serveur pose `default_tools_approval_mode = "approve"` ; le TUI interactif n'a pas été testé ([détails, en anglais](docs/MCP_CLIENTS.md#codex-cli)) |
| **Gemini CLI** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec Gemini CLI 0.58.0**, headless : l'aller-retour MCP depuis un `.gemini/settings.json` de projet, dans un dossier de confiance (`GEMINI_CLI_TRUST_WORKSPACE=true`), avec une clé API ; le mode interactif n'a pas été testé ([détails, en anglais](docs/MCP_CLIENTS.md#gemini-cli)) |
| **Antigravity CLI (agy)** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec agy 1.3.5**, headless seulement (`-p --sandbox --dangerously-skip-permissions`) : l'aller-retour MCP depuis un plugin d'espace de travail (`<projet>/.agents/plugins/<nom>/`) ; chaque serveur de la config globale d'agy démarre aussi ; agy 1.4.2 et le TUI n'ont pas été testés ([détails, en anglais](docs/MCP_CLIENTS.md#antigravity-cli-agy)) |
| **OpenCode** | ✓ | ✓ | — | — | non | **Prouvé le 18/10/2026 avec OpenCode 1.18.30**, headless `opencode run` seulement : l'aller-retour MCP depuis une entrée `mcp` d'un `opencode.json` de projet (`type: "local"`) ; le TUI n'a pas été testé ([détails, en anglais](docs/MCP_CLIENTS.md#opencode)) |
| **Hermes** | ✓ | ✓ | — | — | non — au tour suivant | **Prouvé le 25/08/2026**, MCP et CLI, avant 1.0.0 ; le câblage n'a pas été revérifié pour 1.0.0 ([détails, en anglais](docs/MCP_CLIENTS.md#hermes)) |
| **Tout autre client MCP** | ✓ | ✓ | — | — | non | **Promis** — aucun test propre au harnais |

`valxos-inbox` montre jusqu'à 20 lettres non accusées (`--limit N`) ; accusez avec
`valxos-inbox --ack <msg_id>` pour que les suivantes remontent.

Chaque statut daté du 18/10/2026 veut dire : ce jour-là, sur macOS, contre un
bureau jetable, `whoami`, `send`, `inbox`, `ack` et `history` ont tourné par
le harnais en MCP, et la CLI a lu ou écrit l'autre côté de la lettre.

**Ce qui réveille une session.** Seules les sessions Claude Code sont
réveillées : le Facteur remet la lettre au socket de messagerie propre à la
session, et, sur un réveil, le moniteur du plugin l'affiche (en session
interactive) ; les hooks injectent le courrier en attente au démarrage de la
session, après chaque appel d'outil et avant un arrêt. La poussée du Facteur
dans une session Claude Code 2.1.302 vivante a été observée dans la maison des
auteurs le 18/10/2026 (huit lettres remises au socket de la session par le
Facteur de la release précédente, dont le Facteur 1.0.0 garde la logique de
connexion inchangée) ; la suite de tests vérifie le Facteur 1.0.0 contre un
socket de substitution ; le réveil en session par le moniteur du plugin a été
vérifié en direct le même jour. Sous `claude -p`, le moniteur ne s'arme pas ;
les hooks présentent encore le courrier. Tout autre harnais relève son courrier lui-même en appelant
`inbox` (MCP) ou `valxos-inbox` (CLI) ; rien ne sonne. Dans l'installation des
auteurs, le 25/08/2026, Hermes voyait son courrier au début de son tour
suivant, par un plugin côté Hermes que ce paquet ne livre pas.

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
valxos-migrate-home  valxos-messenger     facteur
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

Avec `--launchd`, l'installeur écrit aussi les deux plists launchd du Facteur
et de la porte web (`com.valxos.messenger.facteur`, `com.valxos.messenger.web`)
sous `~/Library/LaunchAgents/` ; `--launchd-load` les charge. Les plists ne
portent ni `VALXOS_MAISONS` ni `CLAUDE_CONFIG_DIR` : sous launchd, le Facteur
ne parcourt que `~/.claude`, et l'avis `attente` de la porte web sur un envoi
utilise la même liste (voir les limites connues). Détails dans
[`docs/INSTALL_ONE_CLICK.md`](docs/INSTALL_ONE_CLICK.md) (en anglais).

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
l'utiliser et annonce ce repli. Pour la copier explicitement vers le nouveau
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
- Pas de parité complète entre les harnais. MCP et CLI sont des interfaces
  générales ; les hooks, le moniteur et l'inventaire des maisons par défaut
  sont propres à Claude Code.
- Claude Code 2.1.292 et suivants négocient par défaut le protocole MCP
  2026-07-28 avec les serveurs stdio. Ce serveur parle la génération 2025-11-25
  (SDK 1.32). Selon le changelog de Claude Code, un tel serveur est connecté à
  l'ancienne après une première connexion lente, et ce choix est retenu 7
  jours. Prouvé le 18/10/2026 avec Claude Code 2.1.302 : le serveur se connecte
  en session headless et interactive (voir `docs/MCP_CLIENTS.md`, en anglais).
  Si une connexion échoue après une mise à jour de Claude Code, posez
  `MCP_PROTOCOL_NEGOTIATION=legacy` dans l'environnement qui lance Claude Code.
- Claude Code récent diffère les outils MCP derrière sa recherche d'outils.
  `inbox`, `send` et `ack` sont marqués à charger d'emblée
  (`_meta['anthropic/alwaysLoad']`) ; les six autres peuvent devoir être
  chargés avant l'appel. Prouvé le 18/10/2026 avec Claude Code 2.1.302,
  recherche d'outils active (le défaut) : seuls `inbox`, `send` et `ack` sont
  chargés d'emblée ; `whoami`, `history`, `register`, `list_peers`,
  `unregister` et `broadcast` restent différés jusqu'à ce que le modèle les
  charge par ToolSearch.
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
  portent ni `VALXOS_MAISONS` ni `CLAUDE_CONFIG_DIR` : sous launchd, le Facteur
  ne parcourt que `~/.claude`, et l'avis `attente` de la porte web sur un envoi
  utilise la même liste. Si votre configuration Claude Code vit ailleurs,
  ajoutez la variable à l'environnement des deux plists avant de les charger :
  `VALXOS_MAISONS` (la liste complète) ou `CLAUDE_CONFIG_DIR`.
- La page de la porte web et la prose `message`/`motif` des réponses MCP et
  HTTP sont en anglais (depuis cette release) ; les codes MCP `refus` et
  `attente.motif` sont des identifiants stables, documentés dans
  `docs/MCP_CLIENTS.md` (en anglais).

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
