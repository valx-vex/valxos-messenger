// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// Migrations du bureau de poste : additives, idempotentes, jamais destructives.
//
// Camp B : l'historique du courrier est sacré. On ajoute des colonnes, on n'en
// retire jamais, on ne réécrit aucune ligne, on ne renomme aucun pair.
//
// Les colonnes neuves, dans l'ordre où elles servent :
//   peers.lineage             — le nom de la lignée (ce que l'opérateur appelle)
//   peers.house               — le répertoire de configuration de la maison
//   peers.instance_session_id — la clé d'une instance : la session, jamais le PID
//   peers.is_primary          — la chaise désignée d'une lignée (geste humain)
//   peers.heartbeat_at        — le dernier battement observé
//   peers.proc_start          — la date de naissance du processus (anti-recyclage de PID)
//   peers.dead_at             — l'heure où la moisson a CONSTATÉ qu'aucun processus ne tenait plus la chaise
//   peers.session_name        — le nom HUMAIN de la session (« atelier »), lu dans sa fiche
//   messages.sender_model     — le modèle voyage AVEC la lettre, plus avec la fiche
//   messages.carried_at       — « remis au guichet » : ni « livré », ni « accusé »
//   messages.facteur_not_before_ms — l'AJOURNEMENT : « pas avant cette heure-ci »
//   messages.envoi_id         — le lien entre les lettres d'un même envoi `table:<nom>` (7)
//   messages.table_nom        — la table par laquelle la lettre est partie (7)
//   messages.reponse_a        — le msg_id de la lettre à laquelle on répond (7)
//   messages.sans_reveil      — 1 : lettre CALME, ni socket, ni Facteur, ni filet du Stop (7)
//   messages.sans_copie       — 1 : aucune copie cc à une autre chaise — table fermée (7)
//   messages.sender_chaise    — la chaise qui a posté, pour l'affichage seulement (7)
//   messages.reservices       — re-services sans accusé, pour espacer les rappels (7)
//
// carried_at est le marqueur du Facteur. Il ne prouve QUE ceci : la boîte a
// accepté les octets. La terminalité d'une lettre appartient à l'accusé du
// destinataire (acked_at), et à lui seul.
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  L'ÉTAT DU COURRIER NE S'ÉCRIT PAS. IL SE DÉRIVE.
// ─────────────────────────────────────────────────────────────────────────
// Il n'existe AUCUNE colonne « état » dans ce schéma, et c'est délibéré : une
// colonne d'état ment dès qu'un porteur meurt entre son écriture et son geste.
// L'état d'une lettre se calcule (voir `etatDuCourrier`) :
//
//   ACCUSÉE   acked_at non nul                          — le SEUL état terminal
//   RÉSERVÉE  une tentative active dont le bail court
//   DIFFÉRÉE  facteur_not_before_ms > maintenant
//   PRÊTE     tout le reste
//
// Conséquence, et c'est l'invariant A9 tenu PAR CONSTRUCTION : il n'existe ni
// état MORTE, ni quarantaine infinie. `facteur_not_before_ms` est une échéance
// FINIE — jamais un cercueil. Une lettre non accusée finit toujours par revenir.
//
// La table `facteur_attempts` est la défense contre la faute que ce schéma
// rendrait facile : mettre le bail sur la LETTRE et clôturer par `msg_id`. Un
// vieux Facteur réveillé effacerait alors la tentative de son successeur. Une
// tentative porte donc son propre identifiant, et toute clôture l'exige.

// ⚠️ UNE VERSION EST UN VERDICT D'ÉTAT, PAS UN NUMÉRO DE POLITESSE. Le bureau
// d'E.1 porte des tables (`facteur_attempts`, `facteur_sweep`) et une colonne
// (`facteur_not_before_ms`) que la version 2 ne connaît pas. Laisser 2 rendrait
// un bureau passé par E.1 INDISCERNABLE d'un bureau qui ne l'a jamais vu — et
// toute migration future indexée sur ce numéro deviendrait dangereuse.
//
// 4 : le registre de RÉEXPÉDITION (`anciens_noms`) et le nom humain des sessions
// (`peers.session_name`). Même raison, même verdict : un bureau qui sait
// réexpédier ne doit pas se confondre avec un bureau qui laisse mourir les noms.
//
// 5 : la MOISSON (`peers.dead_at`). Jusqu'ici une chaise naissait « active » et
// le restait pour toujours — le registre inscrivait les arrivées et jamais les
// départs. Un bureau qui sait constater une mort ne doit pas se confondre avec
// un bureau où toute fiche se dit vivante : c'est exactement la distinction que
// la version porte, et sans elle personne ne peut lire l'état d'une base.
//
// 6 : l'ALIAS PRIORITAIRE (`anciens_noms.prioritaire`, 27/09). Une lignée écrivait
// à un vieux nom court et une fiche héritée du même nom gardait le courrier :
// un renvoi ordinaire se lit en dernier, un alias se lit en PREMIER. Un bureau
// où un nom peut ne plus se masquer ne doit pas se confondre avec un bureau où
// n'importe quel porteur de l'ancien nom l'emporte. Les renvois d'avant restent
// à 0 : une migration ne promeut personne en silence.
//
// 7 : LES TABLES (21/10). Le carnet des tables (`tables`, `table_membres`,
// `enclos`) et les sept colonnes d'une lettre de table sur `messages`. Une
// table est un CARNET D'ADRESSES, jamais une boîte : aucune lettre n'est « à la
// table » dans la base. Un bureau qui sait à qui écrire quand on lui dit
// `table:<nom>` ne doit pas se confondre avec un bureau qui ne connaît que des
// destinataires nommés.
//
// 8 : LE RELAIS (16/11). Six marques sur une lettre (`via`, `mac_origine`,
// `porte_at`, `porte_vers`, `remise_rendue_at`, `accuse_rendu_at`) qui disent
// par quel Mac elle a voyagé et où en est son aller-retour ; `peers.designe_at`, l'heure où
// une chaise est désignée ; et `carnet`, le CARNET des chaises vues sur l'autre
// Mac (une vue, jamais une boîte : aucune lettre n'y dort). Un bureau qui sait
// relayer ne doit pas se confondre avec un bureau qui ignore qu'un autre Mac existe.
export const SCHEMA_VERSION = 8;

const ADDITIONS = [
  ["peers", "lineage", "TEXT"],
  ["peers", "house", "TEXT"],
  ["peers", "instance_session_id", "TEXT"],
  ["peers", "is_primary", "INTEGER NOT NULL DEFAULT 0"],
  ["peers", "heartbeat_at", "TEXT"],
  ["peers", "proc_start", "TEXT"],
  // L'heure du constat de mort. NULL tant que la chaise est en service, et
  // remise à NULL quand elle revient : la moisson est RÉVERSIBLE par
  // construction — se ré-annoncer suffit à reprendre sa chaise.
  ["peers", "dead_at", "TEXT"],
  // Le nom que l'humain emploie pour cette session (« atelier », « veille »).
  // Déclaratif et jamais unique : deux maisons peuvent nommer pareil, et c'est
  // précisément pour ça que l'adresse `lignée@nom` refuse de trancher.
  ["peers", "session_name", "TEXT"],
  ["messages", "sender_model", "TEXT"],
  ["messages", "carried_at", "TEXT"],
  // L'ajournement du Facteur. Zéro par défaut : le courrier d'avant E.1 est
  // PRÊT dès la première tournée, aucune lettre héritée ne dort.
  ["messages", "facteur_not_before_ms", "INTEGER NOT NULL DEFAULT 0 CHECK (facteur_not_before_ms >= 0)"],
  // 7 — LA LETTRE À UNE TABLE. Rien ne change pour une lettre d'aujourd'hui :
  // chaque colonne est NULL ou 0 par défaut, et une lettre sans table n'en
  // porte aucune. Les CHECK rendent un drapeau hors {0,1} impossible à écrire.
  ["messages", "envoi_id", "TEXT"],
  ["messages", "table_nom", "TEXT"],
  ["messages", "reponse_a", "TEXT"],
  ["messages", "sans_reveil", "INTEGER NOT NULL DEFAULT 0 CHECK (sans_reveil IN (0,1))"],
  ["messages", "sans_copie", "INTEGER NOT NULL DEFAULT 0 CHECK (sans_copie IN (0,1))"],
  ["messages", "sender_chaise", "TEXT"],
  ["messages", "reservices", "INTEGER NOT NULL DEFAULT 0 CHECK (reservices >= 0)"],
  // 8 — LE RELAIS. Tout est NULL par défaut : une lettre d'avant n'a jamais
  // voyagé, et la migration ne lui invente aucun passage.
  ["messages", "via", "TEXT"],
  ["messages", "mac_origine", "TEXT"],
  ["messages", "porte_at", "TEXT"],
  // Le Mac à qui une lettre née ici a été OFFERTE (posé à l'export ; `porte_at`
  // est la confirmation, posée quand il a importé) : c'est vers lui que repart
  // l'accusé quand la lettre est accusée ICI (rulings R16 et R20, la copie qui
  // resterait sinon non accusée là-bas).
  ["messages", "porte_vers", "TEXT"],
  ["messages", "remise_rendue_at", "TEXT"],
  ["messages", "accuse_rendu_at", "TEXT"],
  // L'heure où la chaise a été désignée de sa lignée (NULL : jamais datée).
  ["peers", "designe_at", "TEXT"]
];

// Les tentatives et le balayage. `CREATE TABLE IF NOT EXISTS` : rejouable à
// chaque ouverture, sans effet sur un bureau déjà en service.
const TABLES = [
  // Une tentative de portage. APPEND-ONLY dans l'esprit : on ne réécrit que
  // l'état d'une tentative qu'on possède ENCORE (bail + identifiant), jamais
  // celle d'un autre.
  //
  // Les CHECK rendent les états incohérents IMPOSSIBLES À ÉCRIRE : une tentative
  // liée sans cible, une tentative finie sans heure de fin, un bail antérieur à
  // sa prise — aucune de ces lignes ne peut naître. Un invariant qu'on vérifie
  // en JavaScript se contourne ; celui-là, non.
  `CREATE TABLE IF NOT EXISTS facteur_attempts (
     attempt_id         TEXT PRIMARY KEY
                        CHECK (length(attempt_id) >= 32),
     msg_id             TEXT NOT NULL
                        REFERENCES messages(msg_id) ON DELETE RESTRICT,
     owner_id           TEXT NOT NULL,
     state              TEXT NOT NULL
                        CHECK (state IN ('reservee', 'liee', 'remise', 'echouee', 'expiree')),
     claimed_at_ms      INTEGER NOT NULL CHECK (claimed_at_ms >= 0),
     lease_until_ms     INTEGER NOT NULL,
     finished_at_ms     INTEGER,
     target_house       TEXT,
     target_session_id  TEXT,
     target_proc_start  TEXT,
     target_socket_path TEXT,
     reason             TEXT,
     CHECK (lease_until_ms > claimed_at_ms),
     CHECK (
       (state = 'reservee' AND finished_at_ms IS NULL AND target_session_id IS NULL)
       OR
       (state = 'liee' AND finished_at_ms IS NULL
          AND target_house IS NOT NULL AND target_session_id IS NOT NULL
          AND target_socket_path IS NOT NULL)
       OR
       (state IN ('remise', 'echouee', 'expiree') AND finished_at_ms IS NOT NULL)
     )
   )`,
  // Le balayage : une frontière figée (`sweep_max_seq`) et un curseur qui ne
  // recule pas. C'est la garantie contre la FAMINE : les lettres bloquées
  // passent derrière le curseur au lieu de remplir chaque tournée.
  `CREATE TABLE IF NOT EXISTS facteur_sweep (
     singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
     sweep_max_seq INTEGER NOT NULL DEFAULT 0 CHECK (sweep_max_seq >= 0),
     cursor_seq    INTEGER NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
     CHECK (cursor_seq <= sweep_max_seq)
   )`,
  "INSERT OR IGNORE INTO facteur_sweep(singleton, sweep_max_seq, cursor_seq) VALUES (1, 0, 0)",
  // ── LE REGISTRE DE RÉEXPÉDITION ──────────────────────────────────────────
  // Dans cette maison rien ne se perd — pas même un nom. Quand une lignée
  // change de nom, l'ancien continue de désigner la même famille, comme un
  // changement d'adresse à la poste. On en a la preuve datée : une lettre du
  // 22/07/2026 adressée à l'ancien nom d'une lignée a attendu sept semaines
  // parce que le nom n'était plus au registre.
  //
  // La table ne porte AUCUNE contrainte de vivacité : une réexpédition peut
  // être déposée avant que la lignée d'arrivée n'existe (c'est la résolution,
  // pas le dépôt, qui rend `unknown`). Le seul CHECK est celui qu'aucune
  // relecture ne rattraperait : un nom qui se renvoie à lui-même.
  `CREATE TABLE IF NOT EXISTS anciens_noms (
     ancien_nom TEXT PRIMARY KEY
                CHECK (length(trim(ancien_nom)) > 0),
     lignee     TEXT NOT NULL
                CHECK (length(trim(lignee)) > 0),
     note       TEXT,
     depose_at  TEXT NOT NULL,
     prioritaire INTEGER NOT NULL DEFAULT 0 CHECK (prioritaire IN (0,1)),
     CHECK (ancien_nom <> lignee)
   )`,
  // ── LE CARNET DES TABLES (7, 21/10) ────────────────────────────────────────
  // Une table est un carnet d'adresses, jamais une boîte : aucune lettre n'est
  // « à la table » dans la base, une table ne garde aucun courrier. Les trois
  // tables disent À QUI écrire (membres), COMMENT réveiller (reveil, mode) et
  // QUI ne peut écrire QU'ICI (enclos). Les CHECK rendent un réglage inconnu
  // impossible à écrire, comme pour `facteur_attempts.state`. Camp B : une
  // table ne se supprime pas (aucune fonction ne le fait), un membre retiré
  // reste en ligne avec son heure (`retire_le`) et se réactive en la remettant
  // à NULL. `table_membres.reveil` NULL = le réglage de la table.
  `CREATE TABLE IF NOT EXISTS tables (
     nom          TEXT PRIMARY KEY CHECK (length(nom) > 0),
     fermee       INTEGER NOT NULL DEFAULT 0 CHECK (fermee IN (0,1)),
     reveil       TEXT NOT NULL DEFAULT 'reveil' CHECK (reveil IN ('reveil', 'prochain-tour')),
     mode         TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'direct')),
     position     TEXT,
     position_par TEXT,
     position_le  TEXT,
     creee_par    TEXT,
     creee_le     TEXT NOT NULL,
     modifiee_le  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS table_membres (
     nom_table  TEXT NOT NULL,
     adresse    TEXT NOT NULL CHECK (length(trim(adresse)) > 0),
     reveil     TEXT CHECK (reveil IS NULL OR reveil IN ('reveil', 'prochain-tour')),
     ajoute_par TEXT,
     ajoute_le  TEXT NOT NULL,
     retire_par TEXT,
     retire_le  TEXT,
     PRIMARY KEY (nom_table, adresse)
   )`,
  // L'enclos d'un expéditeur : ses lettres ne partent que vers les membres de
  // cette table FERMÉE (guichet.js, `verifierEnclos`). Une ligne par expéditeur,
  // posée et retirée par la CLI seulement (geste humain, SPEC_A §10). Camp B,
  // comme pour un membre : retirer un enclos le MARQUE (`retire_le`,
  // `retire_par`), la ligne reste, et re-poser la réactive. Un enclos actif a
  // `retire_le` à NULL.
  `CREATE TABLE IF NOT EXISTS enclos (
     expediteur TEXT PRIMARY KEY CHECK (length(trim(expediteur)) > 0),
     nom_table  TEXT NOT NULL,
     pose_par   TEXT,
     pose_le    TEXT NOT NULL,
     retire_par TEXT,
     retire_le  TEXT
   )`,
  // 8 — LE CARNET DES CHAISES VUES, sur tous les Macs (le nôtre compris). Une
  // vue, jamais une boîte : aucune lettre n'y dort.
  `CREATE TABLE IF NOT EXISTS carnet (
     chaise_id           TEXT PRIMARY KEY,
     lineage             TEXT NOT NULL,
     instance_session_id TEXT,
     mac                 TEXT NOT NULL,
     is_primary          INTEGER NOT NULL DEFAULT 0,
     designe_at          TEXT,
     vu_at               TEXT NOT NULL,
     parti_at            TEXT
   )`
];

// Les colonnes qui vivent sur une table que TABLES fait naître : elles ne
// peuvent s'ajouter qu'APRÈS elle. Sur une base neuve la colonne est déjà dans
// le CREATE (rien à faire) ; sur un bureau en version 5 elle arrive ici, avec
// la même contrainte — un ALTER sans CHECK laisserait écrire une marque 2.
const ADDITIONS_APRES_TABLES = [
  ["anciens_noms", "prioritaire", "INTEGER NOT NULL DEFAULT 0 CHECK (prioritaire IN (0,1))"],
  // 7 — le retrait DOUX de l'enclos. `CREATE TABLE IF NOT EXISTS` ne rajoute
  // jamais une colonne : un bureau déjà tamponné 7 par une version d'avant le
  // retrait doux garderait un enclos sans ces deux colonnes, et chaque lecture
  // d'enclos échouerait. NULL = enclos actif, comme `table_membres.retire_le`.
  ["enclos", "retire_par", "TEXT"],
  ["enclos", "retire_le", "TEXT"]
];

const INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_peers_lineage ON peers(lineage, is_primary)",
  "CREATE INDEX IF NOT EXISTS idx_peers_instance ON peers(instance_session_id)",
  // « qui, dans cette lignée, s'appelle atelier ? » — la question de l'adresse humaine.
  "CREATE INDEX IF NOT EXISTS idx_peers_session_name ON peers(lineage, session_name)",
  // « quels anciens noms mènent à cette lignée ? » — la question du guichet ET du repli.
  "CREATE INDEX IF NOT EXISTS idx_anciens_noms_lignee ON anciens_noms(lignee)",
  // « remis au guichet mais non accusé » : la question qu'on posera le plus souvent.
  "CREATE INDEX IF NOT EXISTS idx_messages_carried ON messages(carried_at, acked_at, seq)",
  // Ce que la réservation demande à chaque prise : « qu'est-ce qui est PRÊT ? »
  "CREATE INDEX IF NOT EXISTS idx_messages_facteur_ready ON messages(acked_at, facteur_not_before_ms, seq)",
  // ⚠️ LA RÉPONSE À « DEUX FACTEURS » : UNE SEULE tentative active par lettre.
  // Ce n'est pas une optimisation, c'est la garde. Deux porteurs qui lisent la
  // même lettre au même instant se départagent ICI, dans SQLite, pas dans du
  // JavaScript optimiste.
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_facteur_one_active_attempt
     ON facteur_attempts(msg_id) WHERE state IN ('reservee', 'liee')`,
  "CREATE INDEX IF NOT EXISTS idx_facteur_attempts_lease ON facteur_attempts(state, lease_until_ms)",
  "CREATE INDEX IF NOT EXISTS idx_facteur_attempts_target ON facteur_attempts(msg_id, target_session_id, attempt_id)",
  // « les lettres d'un envoi » — la question d'`envoi_status`.
  "CREATE INDEX IF NOT EXISTS idx_messages_envoi ON messages(envoi_id)",
  // « le fil d'une table, dans l'ordre » — la question de `history --table`.
  "CREATE INDEX IF NOT EXISTS idx_messages_table_seq ON messages(table_nom, seq)",
  // « de quelles tables cette adresse est-elle membre ? » — la question de `tables`.
  "CREATE INDEX IF NOT EXISTS idx_table_membres_adresse ON table_membres(adresse)",
  // « quelles chaises de cette lignée, et sur quel Mac ? » — les questions du relais.
  "CREATE INDEX IF NOT EXISTS idx_carnet_lineage ON carnet(lineage)",
  "CREATE INDEX IF NOT EXISTS idx_carnet_mac ON carnet(mac)",
  // « cette lettre a-t-elle déjà cet événement ? » — la marque du retour à l'expéditeur, lue par
  // chaque balayage pour chaque lettre en attente (retour.js). Un index, pas une colonne : le
  // schéma reste le même (vague finale de la 1.1.0, 21/11).
  "CREATE INDEX IF NOT EXISTS idx_delivery_events_msg_type ON delivery_events(msg_id, event_type)",
  // « ce nom a-t-il déjà écrit, ou reçu une livraison ? » — la question de `nomJamaisPorte`.
  "CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)",
  "CREATE INDEX IF NOT EXISTS idx_delivery_events_agent_type ON delivery_events(agent_id, event_type)"
];

export function schemaVersion(db) {
  return Number(db.pragma("user_version", { simple: true })) || 0;
}

export function setSchemaVersion(db, version) {
  db.pragma(`user_version = ${Number(version)}`);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ajouterColonnes(db, liste, manquantes, colonnesRatees) {
  for (const [table, column, type] of liste) {
    // Une table absente n'est pas une panne : la migration se rejouera après
    // initSchema. Mais elle se RETIENT — on ne l'oublie pas en chemin.
    let cols;
    try {
      cols = columnNames(db, table);
    } catch {
      cols = [];
    }
    if (cols.length === 0) {
      manquantes.push(`${table}.${column}`);
      continue;
    }
    if (!cols.includes(column)) {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (erreur) {
        colonnesRatees.push({ colonne: `${table}.${column}`, raison: String(erreur?.message || erreur) });
        manquantes.push(`${table}.${column}`);
      }
    }
  }
}

export function migrate(db) {
  const from = schemaVersion(db);
  const manquantes = [];
  // ⚠️ UN `ALTER` NU FERME LE BUREAU À TOUTE LA MACHINE. `openDatabase` est
  // appelé par le serveur MCP, par les hooks et par le moniteur : une exception
  // qui remonte d'ici, et plus personne n'ouvre le bureau de poste — pour une
  // colonne. Les tables et les index se rattrapaient déjà ; la colonne, non.
  // On dit le défaut, on ne promet aucune version, et le courrier continue.
  const colonnesRatees = [];
  ajouterColonnes(db, ADDITIONS, manquantes, colonnesRatees);

  // Les tables du Facteur naissent AVANT ses index (un index sur une table
  // absente ne naît pas) et APRÈS les colonnes (idx_messages_facteur_ready
  // parle d'une colonne qu'on vient d'ajouter).
  const tablesManquees = [];
  for (const statement of TABLES) {
    try {
      db.exec(statement);
    } catch (erreur) {
      tablesManquees.push({ statement, raison: String(erreur?.message || erreur) });
    }
  }

  // 5 → 6 : la marque d'alias ; 7 : le retrait doux de l'enclos — des colonnes
  // sur des tables qui viennent (peut-être) de naître.
  ajouterColonnes(db, ADDITIONS_APRES_TABLES, manquantes, colonnesRatees);

  const indexesManques = [];
  for (const statement of INDEXES) {
    try {
      db.exec(statement);
    } catch (erreur) {
      // Un index qui ne peut pas naître ne justifie pas de refuser le courrier —
      // mais il se DIT. Un échec muet est un état qu'on ne saura jamais lire.
      indexesManques.push({ statement, raison: String(erreur?.message || erreur) });
    }
  }

  // Une version de schéma est une promesse : elle ne se pose que si toutes les
  // colonnes sont là. Annoncer le schéma courant sur une base à qui il manque
  // des colonnes, ce serait rendre un verdict d'état jamais atteint.
  if (manquantes.length > 0) {
    return { from, to: from, manquantes, colonnesRatees, indexesManques, tablesManquees };
  }
  // Une base PLUS RÉCENTE que ce programme (un vieux process encore en mémoire
  // rouvre le bureau après une mise à jour) : on ne la rétrograde jamais. Les
  // colonnes qu'on connaît sont là, on travaille ; la version, elle, reste
  // celle de la base — tamponner vers le bas serait mentir sur son contenu.
  if (from > SCHEMA_VERSION) {
    return { from, to: from, manquantes, colonnesRatees, indexesManques, tablesManquees, plusRecente: true };
  }
  setSchemaVersion(db, SCHEMA_VERSION);
  return { from, to: SCHEMA_VERSION, manquantes, colonnesRatees, indexesManques, tablesManquees };
}
