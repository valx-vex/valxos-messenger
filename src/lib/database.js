// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_CARRIED_GRACE_MS,
  DEFAULT_REDELIVER_AFTER_MS,
  GARDE_BUREAU_ENV,
  ensureRuntimeDirs,
  homeDir,
  nowIso,
  runtimePaths,
  valeurDeLEnvironnement,
  writeJsonAtomic
} from "./config.js";
import { migrate } from "./migrations.js";
// format.js n'importe RIEN : aucun cycle à consommer son verdict d'ici.
import { enSouffrance } from "./format.js";
// Le registre est l'autorité sur « qui est qui » : l'accusé lui pose la question
// au lieu de se réinventer une réponse. (registry.js n'importe pas database.js —
// pas de cycle.)
import {
  EN_SERVICE,
  SEPARATEUR_INSTANCE,
  STATUTS_HORS_SERVICE,
  aliasQuiMenentA,
  deciderLaCopie,
  getInstance,
  resolveRecipient,
  verdictDeChaise
} from "./registry.js";

let sharedDb = null;

// LA GARDE DU BUREAU VIVANT (incident du 20/08). La garde va où la donnée
// SORT : l'ouverture du broker (broker.db), en ÉCRITURE — le chemin que TOUT
// appel applicatif traverse pour atteindre le bureau vivant. Une sonde
// intruse ne se DÉCLARE jamais (une garde qui attend une déclaration est un
// théâtre — leçon G1) : c'est le RUN entier qui se clôture, par un env que
// l'orchestrateur pose et que tout descendant hérite. La lecture passe : les
// sondes read-only sur le vrai bureau sont l'outil de travail constant.
// ⚠️ LIMITE CONNUE (v1, dite au GO du 21/08) : ne protège que les processus
// qui héritent de l'env du run — fermeture automatique au backlog.
// ⚠️ CE QUI RESTE POSSIBLE (nommé, pas fermé) : QUATRE écritures fs brutes du
// bureau ne passent pas par ici — status/*.json (writeHeartbeat),
// run/*.stop_guard.json (resetStopGuard), logs/*.log (appendLog) et
// run/facteur.verrou (prendreLeVerrou, facteur/daemon.js). Elles ne sont
// couvertes que TRANSITIVEMENT : sur les chemins réels, ouvrir le broker en
// écriture vient AVANT — le démon ouvre son bureau avant de poser son verrou
// (corrigé le 21/08 : l'ordre inverse laissait un verrou orphelin sur le
// bureau refusé), et src/bin/facteur.js ouvre la base plus tôt encore. Mais
// un appel DIRECT à l'une de ces quatre fonctions, sans passer par une
// ouverture, écrit encore sous garde.
// Le refus précède TOUT effet (même le mkdir des répertoires) : refuser après
// avoir touché le disque ne serait qu'un demi-refus.
//
// ⚠️ LA CIBLE RÉELLE, PAS LE CHEMIN ÉCRIT (revue adverse F1, 21/08 — contournement
// EXÉCUTÉ). Comparer des chaînes laissait passer un LIEN SYMBOLIQUE : un
// `file` qui n'a rien d'un bureau vivant à la lecture, et que SQLite suit
// jusqu'au vrai broker — mesuré, 122 880 octets écrits dans le bureau, garde
// muette. On résout donc les deux côtés avant de comparer.
//
// UNE SEULE BOUCLE, QUI FAIT LES DEUX. À chaque cran elle demande d'abord
// « ce composant est-il un LIEN ? » — si oui elle repart de la cible, queue
// intacte — puis « existe-t-il ? », et sinon elle remonte d'un cran en
// gardant le nom de côté. C'est le fait de RE-TESTER chaque ancêtre comme un
// lien qui compte : une remontée qui ne testait que le chemin de départ
// enjambait une PORTE PENDANTE (un lien vers le RÉPERTOIRE du bureau, quand
// le bureau n'existe pas encore — l'installation fraîche), concluait
// « ailleurs », et `ensureRuntimeDirs` dé-pendait alors le lien en créant le
// bureau AU BOUT. Mesuré à la re-review du 21/08 : 122 880 octets, bureau
// créé, garde muette. Le plafond de 64 sauts arrête les cycles de liens.
//
// ⚠️ CE QUI RESTE, sans arrondi : la casse du système de fichiers (macOS
// l'ignore ; « ~/.CC2CC-V2 » passerait encore) — backlog v2. Et ceci, qui
// n'est PAS un filet de sécurité général : un composant que le disque ne
// connaît pas est gardé TEL QU'ÉCRIT et recollé à la queue — la résolution
// est partielle, jamais abandonnée. Les deux seules sorties vraiment
// lexicales sont la racine du système de fichiers et le plafond de sauts
// (donc un cycle de liens). Ce qui est garanti en revanche, c'est qu'aucun
// appel disque ne s'échappe d'ici : la garde ne fait jamais tomber une
// ouverture légitime.
function cheminReel(candidat) {
  let chemin = path.resolve(String(candidat));
  const queue = [];
  for (let saut = 0; saut < 64; saut += 1) {
    try {
      if (fs.lstatSync(chemin).isSymbolicLink()) {
        chemin = path.resolve(path.dirname(chemin), fs.readlinkSync(chemin));
        continue; // on repart du chemin résolu, queue intacte
      }
    } catch {
      /* pas encore sur le disque */
    }
    try {
      return path.join(fs.realpathSync(chemin), ...queue);
    } catch {
      /* on remonte */
    }
    const parent = path.dirname(chemin);
    if (parent === chemin) return path.join(chemin, ...queue);
    queue.unshift(path.basename(chemin));
    chemin = parent;
  }
  return path.join(chemin, ...queue);
}

function refuserLeBureauVivantSousGarde(file, readonly) {
  if (readonly || !valeurDeLEnvironnement(process.env, GARDE_BUREAU_ENV)) return;
  const bureauxVivants = [".valxos-messenger", ".cc2cc-v2"]
    .map((nom) => cheminReel(path.join(homeDir(), nom)));
  const cible = cheminReel(file);
  const bureauVivant = bureauxVivants.find(
    (bureau) => cible === bureau || cible.startsWith(bureau + path.sep)
  );
  if (!bureauVivant) return;
  throw new Error(
    `live office guard: opening ${cible} for WRITING is refused. ` +
      `This run set ${GARDE_BUREAU_ENV}. Point VALXOS_MESSENGER_HOME ` +
      `(or CC2CC_V2_HOME) at a throwaway office (mkdtemp), ` +
      `or lift the guard (env -u ${GARDE_BUREAU_ENV}) for a deliberate operator gesture.`
  );
}

// La même garde, pour une écriture fs BRUTE qui ne passe pas par une ouverture
// du broker (le refus de chaise d'un sous-agent se journalise AVANT toute
// ouverture : il n'a droit à aucun regard sur la base). Lève comme l'ouverture.
export function garderLEcritureDuBureau(file = runtimePaths().db) {
  refuserLeBureauVivantSousGarde(file, false);
}

export function openDatabase({ file = runtimePaths().db, readonly = false } = {}) {
  refuserLeBureauVivantSousGarde(file, readonly);
  // Une ouverture en LECTURE SEULE n'écrit rien, dossiers compris : le fichier
  // existe déjà ou l'ouverture échoue, et ce n'est pas à un lecteur (le médecin)
  // de créer les dossiers d'un bureau qu'il se contente de regarder.
  if (!readonly) ensureRuntimeDirs();
  const db = new Database(file, { readonly });
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 3000");
    db.pragma("foreign_keys = ON");
    initSchema(db);
    // Le schéma de base naît par CREATE TABLE IF NOT EXISTS : sur un bureau de
    // poste déjà ouvert, il ne fait RIEN. Les colonnes neuves n'arrivent donc
    // que par ici, à chaque ouverture, en additif.
    migrate(db);
  }
  return db;
}

export function getDatabase() {
  if (!sharedDb) sharedDb = openDatabase();
  return sharedDb;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT UNIQUE NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      thread_id TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      msg_type TEXT NOT NULL DEFAULT 'message',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      delivered_at TEXT,
      injected_at TEXT,
      acked_at TEXT,
      source TEXT,
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_recipient_delivered
      ON messages(recipient, delivered_at, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_injected
      ON messages(recipient, injected_at, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_acked
      ON messages(recipient, acked_at, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, seq);

    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      project_path TEXT,
      description TEXT,
      session_id TEXT,
      pid INTEGER,
      hostname TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_peers_session ON peers(session_id);
    CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status, last_seen);

    CREATE TABLE IF NOT EXISTS delivery_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      event_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      detail_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_delivery_events_msg
      ON delivery_events(msg_id, event_at);
  `);
}

export function generateMessageId() {
  return `msg-${crypto.randomUUID()}`;
}

export function normalizePriority(priority) {
  const value = String(priority || "normal").toLowerCase();
  return ["low", "normal", "high", "critical"].includes(value) ? value : "normal";
}

export function normalizeMessageType(type) {
  const value = String(type || "message").toLowerCase();
  return ["message", "task", "response", "status", "broadcast"].includes(value)
    ? value
    : "message";
}

// LES CHAMPS QUE LE POSTEUR TAPE, ET EUX SEULS (ronde 2, ⑧).
// Ce sont les seuls qu'un rejeu peut ÉCARTER de façon intéressante. En sont
// exclus `created_at` (une horloge, jamais tapée — elle divergerait à CHAQUE
// rejeu et noierait le signal), `source` et `raw_json` (de la plomberie).
//
// ⚠️ ET CHAQUE CHAMP PORTE SES ORTHOGRAPHES, parce que la question « ce champ
// a-t-il été TAPÉ ? » ne se pose pas sur `msg` (qui est déjà normalisé, avec
// ses défauts posés) mais sur ce que l'appelant a réellement passé. Sans cette
// table, la comparaison portait sur TOUS les champs, fournis ou non : une
// surface qui n'écrit pas de sujet — la porte web en écrit un NUL à chaque
// dépôt — s'entendait dire qu'on lui avait « écarté » un sujet qu'elle n'avait
// jamais tapé. Un signal qui crie sur ce que personne n'a écrit est un signal
// qu'on cesse de lire, et c'est exactement ce que le remède ⑧ voulait éviter.
const ORTHOGRAPHES_DU_POSTEUR = {
  sender: ["sender", "from"],
  recipient: ["recipient", "to"],
  thread_id: ["thread_id", "threadId"],
  subject: ["subject"],
  body: ["body", "text"],
  priority: ["priority"],
  msg_type: ["msg_type", "type"],
  sender_model: ["sender_model", "senderModel"]
};

const CHAMPS_DU_POSTEUR = Object.keys(ORTHOGRAPHES_DU_POSTEUR);

// FOURNI = une des orthographes du champ porte une valeur. `null` compte comme
// « pas fourni » : c'est ce qu'écrit une surface qui n'a rien à dire de ce
// champ-là, et on ne distingue pas un nul explicite d'un champ absent — les
// deux veulent dire la même chose au posteur.
function champFourni(input, champ) {
  return ORTHOGRAPHES_DU_POSTEUR[champ].some((clef) => input[clef] !== undefined && input[clef] !== null);
}

// INSCRIRE UNE LETTRE — et RENDRE les deux faits que seule cette fonction sait.
//
// ⚠️ POURQUOI CETTE FONCTION EXISTE (ronde 2, 22/08 — ⑦ et ⑧). `insertMessage`
// savait deux choses que personne ne pouvait lui demander, et que le guichet
// essayait de reconstituer APRÈS COUP par une comparaison :
//   · quel destinataire l'appelant a DEMANDÉ — elle le normalise elle-même
//     (`input.recipient || input.to`, DEUX orthographes acceptées) ;
//   · si la ligne rendue est NEUVE ou RETROUVÉE (`row.changes`).
// Tant que ces deux faits restaient enfermés ici, toute surface qui voulait les
// connaître devait les DEVINER. Le guichet devinait sur `row.recipient !==
// entree.recipient`, et il se trompait des deux côtés : rejeu annoncé sur une
// lettre neuve écrite `{to}` (⑦), rejeu tu sur un corps jeté (⑧).
//
// La leçon, écrite ici parce que c'est ici qu'elle se paie : un remède qui
// DÉPLACE un fait doit déplacer AUSSI la source du fait — sinon il ne l'a pas
// déplacé, il l'a remplacé par une devinette.
//
// Rend `{ row, neuve, demande, ecarte }` :
//   row     — la ligne STOCKÉE (neuve ou retrouvée), à l'identique d'avant ;
//   neuve   — true si cet appel-ci a créé la ligne, false si un msg_id connu
//             l'a fait gagner (LE FAIT du rejeu, jamais une déduction) ;
//   demande — le destinataire tel que CET appel l'a demandé, normalisé UNE
//             SEULE FOIS, ici. Le jour où une troisième orthographe s'ajoute,
//             il n'y a rien à mettre à jour ailleurs — c'est le point.
//   ecarte  — sur un rejeu, ce que le posteur vient de taper et qui n'est parti
//             NULLE PART (`{champ: valeur demandée}`), ou null quand rien n'a
//             été perdu. Un renvoi strictement identique n'écarte rien.
export function inscrireUneLettre(db, input) {
  const msg = {
    msg_id: input.msg_id || generateMessageId(),
    sender: input.sender || input.from,
    recipient: input.recipient || input.to,
    thread_id: input.thread_id || input.threadId || null,
    subject: input.subject || null,
    body: input.body || input.text || "",
    priority: normalizePriority(input.priority),
    msg_type: normalizeMessageType(input.msg_type || input.type),
    created_at: input.created_at || input.timestamp || nowIso(),
    source: input.source || "cc2cc-v2",
    raw_json: input.raw_json || null,
    // Le modèle voyage AVEC la lettre. La fiche du pair ne le sait pas : elle
    // est estampillée par le dernier hook passé, sous-agents compris.
    // Inconnu se dit NULL — jamais « le dernier qu'on a vu ».
    sender_model: input.sender_model || input.senderModel || null
  };
  if (!msg.sender || !msg.recipient || !msg.body) {
    throw new Error("insertMessage requires sender, recipient, and body");
  }

  const row = db
    .prepare(`
      INSERT INTO messages (
        msg_id, sender, recipient, thread_id, subject, body,
        priority, msg_type, created_at, source, raw_json, sender_model
      )
      VALUES (
        @msg_id, @sender, @recipient, @thread_id, @subject, @body,
        @priority, @msg_type, @created_at, @source, @raw_json, @sender_model
      )
      ON CONFLICT(msg_id) DO NOTHING
    `)
    .run(msg);
  const stored = getMessageById(db, msg.msg_id);
  const neuve = row.changes > 0;
  if (neuve) {
    recordEvent(db, msg.msg_id, msg.recipient, "created", { sender: msg.sender });
  }

  // CE QUE LE REJEU A JETÉ. La comparaison se fait ICI et nulle part ailleurs,
  // parce qu'ICI seulement les deux valeurs existent côte à côte, déjà
  // normalisées : ce que l'appelant a demandé (`msg`) et ce que la base garde
  // (`stored`). La refaire dans une surface, c'est re-comparer un `input` BRUT
  // à une ligne normalisée — et donc mentir sur `priority` ou `msg_type`.
  let ecarte = null;
  if (!neuve && stored) {
    for (const champ of CHAMPS_DU_POSTEUR) {
      // CE QUE L'APPELANT N'A PAS TAPÉ NE PEUT PAS LUI AVOIR ÉTÉ ÉCARTÉ.
      if (!champFourni(input, champ)) continue;
      if (msg[champ] !== stored[champ]) {
        ecarte ??= {};
        ecarte[champ] = msg[champ];
      }
    }
  }

  return { row: stored, neuve, demande: msg.recipient, ecarte };
}

// LA SIGNATURE HISTORIQUE, INTACTE. Une cinquantaine d'appelants et toute la
// suite lisent la LIGNE STOCKÉE et rien d'autre : on ajoute à côté
// (`inscrireUneLettre`), on ne casse pas au milieu.
export function insertMessage(db, input) {
  return inscrireUneLettre(db, input).row;
}

export function getMessageById(db, msgId) {
  return db.prepare("SELECT * FROM messages WHERE msg_id = ?").get(msgId);
}

// Ce que le canal de repli (les hooks) doit servir.
//
// ⚠️ CETTE FENÊTRE GOUVERNE LE PORTEUR, JAMAIS LE DESTINATAIRE (remède de la
// revue adverse #3, C3 — un contrôleur a lu ce commentaire comme une règle générale et
// nommé un défaut ailleurs qui n'en est pas un ; la faute est ICI, dans le
// silence). Ce que la suite décrit s'applique à CETTE fonction (le canal de
// repli — un PORTEUR qui pousse) et à elle seule. `listInbox`, ce que `inbox`
// (CLI et MCP) utilise pour RELEVER sa propre boîte, ne lit AUCUNE fenêtre :
// `WHERE recipient = ? AND acked_at IS NULL`, un point. Un destinataire qui
// regarde deux fois son courrier non lu n'est pas une double livraison —
// c'est juste regarder deux fois. Les deux posent la MÊME marque
// (`markDelivered`, `delivered_at` avance dans les deux cas) ; seule LA
// SÉLECTION diffère, et c'est elle qui porte la fenêtre — jamais la marque.
//
// L'INVARIANT QUI PRIME SUR TOUT (A9) : « acked_at nul ⇒ la lettre finit
// toujours par revenir ». Aucune marque posée par un porteur ne peut rendre une
// lettre durablement invisible, parce qu'aucune marque de porteur ne prouve que
// quelqu'un a lu. Seul l'accusé du destinataire est terminal.
//
// Deux fenêtres, et deux seulement :
//   `carried_at`   — le Facteur a remis au guichet : on laisse au destinataire
//                    une fenêtre de GRÂCE pour accuser lui-même avant de re-servir.
//   `delivered_at` — un porteur de contexte a dit « je l'ai mise dans le
//                    contexte » : un hook, ou la relève au guichet (CLI et MCP
//                    `inbox` posent la même marque, mais SANS jamais lire cette
//                    fenêtre — voir l'avertissement plus haut). Il a pu mourir
//                    juste après, entre la marque et le texte : passé la
//                    fenêtre de RE-SERVICE, sans accusé, la lettre repart —
//                    ICI, dans getPendingForContext, jamais dans listInbox.
//
// Conséquence assumée (A8) : un même courrier peut revenir PAR CE CANAL. On
// préfère un doublon à une lettre perdue — mais UN doublon par fenêtre, jamais
// une avalanche. Chaque re-service fait AVANCER `delivered_at` (voir
// `markDelivered`) : une lettre jamais accusée revient donc au plus une fois
// par fenêtre de re-service PAR CE CHEMIN, et elle revient
// aussi longtemps qu'il le faudra.
// `recipient` accepte UN nom ou PLUSIEURS (`adressesDuRepli`) : une session
// relève la boîte de sa lignée et celle de ses propres chaises. Aucune adresse
// ne rend aucune lettre — jamais toutes.
// `parUrgence` (remède du review interne, IMPORTANT 1) : par défaut cette
// fonction trie par ancienneté (`seq ASC`, inchangé — des dizaines
// d'assertions existantes dépendent de cet ordre). Quand `parUrgence` est
// posé, SQLite trie sur TOUT l'ensemble en attente, jamais sur une fenêtre
// bornée récupérée puis réduite en JS : le filet de Stop avait un
// `limit:20` + un reducer JS qui masquait toute lettre urgente AU-DELÀ de la
// 20e (prouvé : 20×LOW puis une HIGH en position 21 → invisible — le défaut
// que le remède précédent devait fermer, simplement déplacé derrière un
// seuil). Le rang inconnu tombe dans NORMAL (`ELSE 1`), jamais sous LOW :
// une priorité malformée ne doit jamais se faire plus discrète qu'une vraie
// LOW (même remède, MINEUR 4).
export function getPendingForContext(
  db,
  recipient,
  {
    limit = 20,
    carriedGraceMs = DEFAULT_CARRIED_GRACE_MS,
    redeliverAfterMs = DEFAULT_REDELIVER_AFTER_MS,
    now = null,
    parUrgence = false
  } = {}
) {
  const adresses = (Array.isArray(recipient) ? recipient : [recipient])
    .map((nom) => String(nom || "").trim())
    .filter(Boolean);
  if (adresses.length === 0) return [];

  const instant = new Date(now || nowIso()).getTime();
  const finDeGrace = new Date(instant - Number(carriedGraceMs || 0)).toISOString();
  const finDuReService = new Date(instant - Number(redeliverAfterMs || 0)).toISOString();
  const trous = adresses.map(() => "?").join(", ");
  const tri = parUrgence
    ? `ORDER BY CASE priority
         WHEN 'critical' THEN 3
         WHEN 'high' THEN 2
         WHEN 'normal' THEN 1
         WHEN 'low' THEN 0
         ELSE 1
       END DESC, seq ASC`
    : "ORDER BY seq ASC";
  return db
    .prepare(`
      SELECT * FROM messages
      WHERE recipient IN (${trous})
        AND acked_at IS NULL
        AND (carried_at IS NULL OR carried_at <= ?)
        AND (delivered_at IS NULL OR delivered_at <= ?)
      ${tri}
      LIMIT ?
    `)
    .all(...adresses, finDeGrace, finDuReService, limit);
}

// UN SÉLECTEUR D'AVANT A9 — aucun appelant en production aujourd'hui (ni le
// Facteur, ni `getPendingForContext` juste au-dessus, qui sert vraiment le
// canal de repli). `carried_at` n'est pas un état terminal : filtrer dessus
// rendrait invisible une lettre déjà remise mais jamais accusée — A9 mort. Le
// Facteur ne l'utilise pas et ne doit JAMAIS l'utiliser. Elle survit par
// Camp B (rien ne s'efface) ; ne la branchez sur aucun chemin de livraison.
export function getPendingForCarrier(db, { recipient = null, limit = 50 } = {}) {
  const clause = recipient ? "AND recipient = @recipient" : "";
  return db
    .prepare(`
      SELECT * FROM messages
      WHERE carried_at IS NULL
        AND delivered_at IS NULL
        AND acked_at IS NULL
        ${clause}
      ORDER BY seq ASC
      LIMIT @limit
    `)
    .all(recipient ? { recipient, limit } : { limit });
}

// « Remis au guichet, mais jamais accusé » : la seule question qui dit si une
// lettre est vraiment arrivée à quelqu'un.
export function getCarriedUnacked(db, { recipient = null, limit = 100 } = {}) {
  const clause = recipient ? "AND recipient = @recipient" : "";
  return db
    .prepare(`
      SELECT * FROM messages
      WHERE carried_at IS NOT NULL
        AND acked_at IS NULL
        ${clause}
      ORDER BY seq ASC
      LIMIT @limit
    `)
    .all(recipient ? { recipient, limit } : { limit });
}

// L'EN-SOUFFRANCE, REQUÊTÉE (H2) — la question de getCarriedUnacked, élargie et
// enfin consommée : quelles lettres attendent une signature depuis trop
// longtemps, ou après trop d'échecs ? Le VERDICT appartient à format.js
// (`enSouffrance`, une seule vérité) ; ici on ne fait que lui apporter ses
// faits : le compte de tentatives CLOSES et le dernier motif d'échec, lus dans
// `facteur_attempts` — LA BASE SUFFIT, jamais le journal du démon (un
// diagnostic qui dépend d'un fichier de log ment après une rotation).
// ⚠️ Le compte SQL réplique `tentativesInfructueuses` (round.js) : importer
// round.js d'ici serait un cycle (round.js importe recordEvent). La
// duplication se paie par un test qui compare les deux, terme à terme
// (test/souffrance.test.js).
// ⚠️ LE DERNIER MOTIF SE CLASSE PAR `rowid`, JAMAIS PAR `finished_at_ms` —
// même doctrine que la série de round.js. Une tournée lit l'horloge deux fois
// et `docs/FACTEUR.md` (point 6) admet les reculs : une tentative close APRÈS
// peut porter une estampille PLUS VIEILLE que sa devancière, et un classement
// par estampille ferait alors répéter au médecin un motif PÉRIMÉ. Le `rowid`
// est l'ordre de prise — les tentatives d'une lettre sont séquentielles
// (l'index unique partiel `uq_facteur_one_active_attempt`) et rien ne s'efface
// jamais de `facteur_attempts` (Camp B) : il EST la chronologie.
// Le filtre écarte la REMISE avant de classer, et c'est voulu : une lettre
// remise mais jamais signée reste en souffrance, et ce qu'on veut lire d'elle
// est son dernier ÉCHEC, pas un blanc.
// ⚠️ AUCUNE BORNE PAR DÉFAUT. Un `limit = 200` silencieux ferait mentir le
// prochain appelant comme il a fait mentir le médecin (total plafonné à 200,
// corrigé par un correctif antérieur) : les deux consommateurs d'aujourd'hui passent
// leur propre `Number.MAX_SAFE_INTEGER`, mais un défaut qui tronque n'attend
// que le troisième. Les seules bornes légitimes sont celles de l'APPELANT et
// celle de l'AFFICHAGE — et celle-là se nomme au rapport
// (`destinataires_au_dela_de_la_borne`).
export function lettresEnSouffrance(
  db,
  { maintenant = Date.now(), seuils, limit = Number.MAX_SAFE_INTEGER } = {}
) {
  const candidates = db
    .prepare(`
      SELECT m.*,
        (SELECT count(*) FROM facteur_attempts a
          WHERE a.msg_id = m.msg_id AND a.state IN ('remise', 'echouee', 'expiree')) AS tentatives,
        (SELECT a.reason FROM facteur_attempts a
          WHERE a.msg_id = m.msg_id AND a.state IN ('echouee', 'expiree') AND a.reason IS NOT NULL
          ORDER BY a.rowid DESC LIMIT 1) AS dernier_motif
      FROM messages m
      WHERE m.acked_at IS NULL
      ORDER BY m.seq ASC
    `)
    .all();
  const verdicts = [];
  for (const row of candidates) {
    const verdict = enSouffrance(row, { tentatives: row.tentatives, maintenant, seuils });
    if (!verdict) continue;
    verdicts.push({
      ...row,
      depuis_ms: verdict.depuis_ms,
      tentatives: verdict.tentatives,
      prochaine_reprise_ms: Number(row.facteur_not_before_ms || 0)
    });
    if (verdicts.length >= limit) break;
  }
  return verdicts;
}

export function getPendingForMonitor(db, recipient, { limit = 50 } = {}) {
  return db
    .prepare(`
      SELECT * FROM messages
      WHERE recipient = ?
        AND acked_at IS NULL
        AND injected_at IS NULL
      ORDER BY seq ASC
      LIMIT ?
    `)
    .all(recipient, limit);
}

// LA BOÎTE, PAS LE PORTEUR. `inbox` (CLI et MCP) relève sa PROPRE
// correspondance à la demande : `recipient` et `acked_at IS NULL`, rien
// d'autre — AUCUNE fenêtre de re-service (voir l'avertissement au-dessus de
// `getPendingForContext`, remède de la revue adverse #3, C3). Deux appels à cinq minutes
// d'écart rendent la MÊME lettre non accusée, et c'est VOULU : regarder deux
// fois son courrier non lu n'est pas une double livraison. La fenêtre
// gouverne le canal de repli (un PORTEUR qui pousse), jamais celui-ci.
// L'ALIAS À LA RELÈVE (Task 6, fix 1) : la boîte de `recipient` comprend
// aussi les noms dont la chaîne d'alias mène à lui (`aliasQuiMenentA`). Une
// lettre remise sous un alias reçoit sa ligne `alias_applique` — une seule par
// lettre, `journaliserAlias` garde l'unicité, quel que soit le chemin.
export function listInbox(db, recipient, { limit = 20, includeInjected = true } = {}) {
  const injectedClause = includeInjected ? "" : "AND injected_at IS NULL";
  const noms = [recipient, ...aliasQuiMenentA(db, recipient)];
  const trous = noms.map(() => "?").join(", ");
  const rows = db
    .prepare(`
      SELECT * FROM messages
      WHERE recipient IN (${trous})
        AND acked_at IS NULL
        ${injectedClause}
      ORDER BY seq ASC
      LIMIT ?
    `)
    .all(...noms, limit);
  if (noms.length > 1) {
    for (const row of rows) {
      if (row.recipient !== recipient) journaliserAlias(db, row, () => resolveRecipient(db, row.recipient), recipient);
    }
  }
  return rows;
}

// LES COPIES (Run 6, Task 7, 27/09) : visibles, jamais livrées. Aucune colonne
// de la lettre ne bouge — ni `delivered_at`, ni `injected_at`, ni `acked_at` ;
// seule une trace `cc_vu` par CHAISE empêche la répétition. La marque est la
// même pour les hooks, le guichet MCP et le moniteur Python : une copie vue par
// l'un ne se redit pas par l'autre.
export function getCopiesPourChaise(db, lignee, chaiseId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.recipient = ? AND m.acked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM delivery_events e
        WHERE e.msg_id = m.msg_id AND e.agent_id = ? AND e.event_type = 'cc_vu'
      )
    ORDER BY m.seq ASC LIMIT ?`).all(lignee, chaiseId, limit);
}

export function marquerCopiesVues(db, rows, chaiseId, { via = null } = {}) {
  if (!rows || rows.length === 0 || !chaiseId) return 0;
  const tx = db.transaction((items) => {
    for (const r of items) recordEvent(db, r.msg_id, chaiseId, "cc_vu", via ? { lignee: r.recipient, via } : { lignee: r.recipient });
  });
  tx(rows);
  return rows.length;
}

// La marque de livraison AVANCE à chaque service : elle ne se fige pas au premier
// passage. Elle ne dit pas « cette lettre a été livrée un jour », elle dit « voilà
// quand on l'a mise pour la DERNIÈRE fois sous les yeux du destinataire » — et la
// fenêtre de re-service repart de ce moment-là.
//
// Figée (`COALESCE`), la marque restait celle du tout premier passage : une lettre
// jamais accusée restait éternellement au-delà de la fenêtre et repartait à CHAQUE
// appel d'outil, pour toujours. A8 préfère un doublon à une lettre perdue — un
// doublon, pas une avalanche qui empêche le destinataire de travailler. Avancer la
// marque borne le retour à un par fenêtre sans jamais éteindre A9 : la fenêtre
// repart, elle ne se ferme pas.
//
// L'autre moitié de la marque : elle n'avance QUE sur les lettres réellement
// servies. `rows` est ce que l'appelant vient de poser sous les yeux du
// destinataire, et rien d'autre — une lettre qu'on n'a pas remise garde sa marque,
// donc son tour. Un chemin qui ne sert rien (le verrou d'arrêt, par exemple) ne
// marque jamais : sinon la marque mentirait et repousserait sans fin une lettre que
// personne n'a lue, ce qui tuerait A9 en silence.
// `acteurReel` (remède de la revue adverse #4 — HAUT 1, deuxième moitié) : ADDITIF,
// jamais un remplacement. `agentId` reste ce qui est ÉCRIT comme
// attribution — le nom déclaré, légitimement plus large que qui a VRAIMENT
// déclenché le geste (une chaise peut signer pour SA lignée). Quand
// `acteurReel` diffère de `agentId`, le detail_json le garde : l'attribution
// ne peut plus se maquiller en silence, même sur un chemin AUTORISÉ. Absent
// (comme avant ce remède), aucun champ n'apparaît — les consommateurs
// existants de detail_json ne voient rien de nouveau.
export function markDelivered(db, rows, agentId, eventType = "delivered", { at = null, acteurReel = null } = {}) {
  const seqs = rows.map((row) => row.seq).filter(Boolean);
  if (seqs.length === 0) return 0;
  const stamp = at || nowIso();
  const detail = acteurReel && acteurReel !== agentId ? { acteur_reel: acteurReel } : {};
  const tx = db.transaction((items) => {
    const update = db.prepare("UPDATE messages SET delivered_at = ? WHERE seq = ?");
    for (const row of items) {
      update.run(stamp, row.seq);
      recordEvent(db, row.msg_id, agentId, eventType, detail);
    }
  });
  tx(rows);
  return seqs.length;
}

// La marque du guichet. Elle prouve UNE chose : la boîte a accepté les octets.
// Ce n'est pas « livré », et c'est encore moins « accusé ». Le Facteur ne pose
// jamais `delivered_at` : la terminalité d'une lettre appartient à l'accusé du
// destinataire, et à lui seul.
// Le compte rendu est celui des lettres RÉELLEMENT marquées, jamais celui des
// lettres qu'on a tendues : une ligne périmée dont le `seq` n'existe plus n'a
// été remise à personne, et un compte qui ne compte pas ce que son nom dit est
// un compte qui ment.
export function markCarried(db, rows, agentId, { at = null, eventType = "facteur_remis" } = {}) {
  if (!rows || rows.length === 0) return 0;
  const stamp = at || nowIso();
  let marquees = 0;
  const tx = db.transaction((items) => {
    const update = db.prepare("UPDATE messages SET carried_at = COALESCE(carried_at, ?) WHERE seq = ?");
    for (const row of items) {
      if (update.run(stamp, row.seq).changes === 0) continue;
      marquees += 1;
      recordEvent(db, row.msg_id, agentId, eventType, {});
    }
  });
  tx(rows);
  return marquees;
}

export function markInjected(db, rows, agentId) {
  if (rows.length === 0) return 0;
  const tx = db.transaction((items) => {
    const update = db.prepare("UPDATE messages SET injected_at = COALESCE(injected_at, ?) WHERE seq = ?");
    for (const row of items) {
      update.run(nowIso(), row.seq);
      recordEvent(db, row.msg_id, agentId, "injected", {});
    }
  });
  tx(rows);
  return rows.length;
}

// L'ACCUSÉ — le seul geste terminal du bureau de poste, donc le mieux gardé.
//
// Sous A9 (« accusé nul ⇒ la lettre finit toujours par revenir »), `acked_at` est
// la SEULE marque qui éteint définitivement une lettre : le guichet, la livraison
// et l'injection finissent toutes par se laisser rattraper par le repli, celle-ci
// jamais. Un accusé posé par la mauvaise main ne dérange donc pas le destinataire,
// il fait DISPARAÎTRE son courrier. On ne signe pas le courrier d'un autre.
//
// L'erreur du refus. Typée, parce qu'un refus qu'on peut confondre avec un
// « message absent » (null) est un refus qu'un appelant distrait transformera en
// succès. Ici, se tromper coûte une lettre : on lève.
export class AccuseRefuse extends Error {
  constructor(msgId, agentId, destinataire, raison) {
    super(
      `ack refused: "${agentId ?? ""}" cannot sign ${msgId}, addressed to "${destinataire}": ${raison}`
    );
    this.name = "AccuseRefuse";
    this.code = "accuse_refuse";
    this.msgId = msgId;
    this.agentId = agentId ?? null;
    this.destinataire = destinataire;
    this.raison = raison;
  }
}

function enService(row) {
  // Deux façons de quitter le service, une seule question : cette chaise
  // reçoit-elle encore ? `offline` est un geste humain, `dead` un constat de la
  // moisson — pour le courrier, les deux valent pareil.
  return Boolean(row) && !STATUTS_HORS_SERVICE.includes(String(row.status || ""));
}

// Une lignée est EN SERVICE quand quelqu'un de vivant porte encore son nom :
// une chaise en service, ou une fiche héritée d'avant les lignées (Camp B).
// C'est exactement la question à laquelle `resolveRecipient` répond — tout ce
// qui n'est pas `unknown` veut dire « ce nom a encore quelqu'un derrière ».
function ligneeEnService(db, lignee) {
  return resolveRecipient(db, lignee).kind !== "unknown";
}

// Qui a le droit de signer — et pourquoi la porte n'a pas la même largeur des
// deux côtés. Les quatre règles, dans l'ordre où elles sont lues :
//
//   1. LE NOM EXACT du destinataire. Une fiche RETIRÉE DU SERVICE ne signe
//      plus : « une instance retirée du service ne lit plus rien » doit valoir
//      pour une LIGNÉE comme pour une chaise, sinon ce n'est pas une porte —
//      c'est une porte d'un seul côté. Sortir du service n'enterre pourtant
//      aucune lettre : se ré-annoncer rend le droit de signer (registerPeer
//      repose `active`), et une chaise en service de la lignée peut signer
//      entre-temps par la règle 2.
//      ⚠️ LIMITE DÉCLARÉE : une fiche ABSENTE n'est pas une fiche retirée. Le
//      registre ne sait rien de ce nom, et le courrier adressé à un nom d'avant
//      le registre (Camp B, rosters, fiches héritées) doit rester accusable —
//      le refuser perdrait des lettres qui n'ont rien demandé. Ce n'est donc PAS
//      une preuve d'existence, seulement le refus d'un retrait explicite. Le
//      jour où toute lettre naît d'un nom enregistré, cette tolérance se retire
//      en supprimant le `fiche &&`.
//
//   2. Une CHAISE signe pour SA lignée. Elle se nomme précisément, on la tient
//      précisément : connue du registre ET en service, et elle ne signe QUE son
//      propre nom et celui de sa lignée — jamais le courrier nominatif de sa
//      sœur.
//
//   3. Une LIGNÉE signe pour une chaise de SA lignée. ⚠️ CETTE PORTE EST PLUS
//      LARGE QUE LA 2, ET C'EST DÉLIBÉRÉ. Le guichet MCP ne sait dériver qu'un
//      nom de LIGNÉE (`selfId`), là où le repli sert à chaque session le
//      courrier de SA CHAISE (`adressesDuRepli`). Exiger ici que le registre
//      tranche la lignée vers cette chaise-là fermait la porte exactement quand
//      l'adressage nominatif sert à quelque chose : deux chaises vivantes, et le
//      VRAI destinataire ne pouvait plus éteindre sa propre lettre — elle
//      revenait toutes les dix minutes, pour toujours. Un geste terminal
//      inatteignable n'est pas un verrou, c'est une fuite d'A9 par le haut.
//      Ce qu'on accepte en échange, en toutes lettres : une session de la lignée
//      B peut éteindre la lettre d'une chaise sœur SI elle en connaît le msg_id
//      — et le repli ne le lui donne jamais. Ce n'est pas le tirage au sort que
//      le registre a chassé : le registre arbitre QUI LIT une lettre (le risque
//      = lue par la mauvaise personne), on arbitre ici QUI L'ÉTEINT alors qu'il
//      la tient déjà. Et la largeur est TRAÇABLE : la raison voyage jusque dans
//      l'événement `acked`, donc chaque passage par cette porte se retrouve au
//      journal.
//      ELLE SE REFERME TOUTE SEULE, sans toucher une ligne d'ici, le jour où le
//      guichet dérivera une chaise : qui se nomme précisément retombe sur la
//      règle 2, qui est stricte. Se nommer précisément RÉDUIT son pouvoir.
//
//   4. LA PORTE DE LA RÉSOLUTION — on signe ce que le guichet nous a fait porter.
//      Les trois portes du dessus ne connaissent que deux FORMES d'adresse : le
//      nom exact et `lignée#session`. Le guichet, lui, en livre d'autres — un
//      ANCIEN nom (« alice » → « claude-alice »), une adresse humaine
//      (« claude-alice@atelier ») — et le repli va bel et bien chercher ce
//      courrier-là. Une liste de formes écrite ICI se désynchronise du guichet à
//      la première adresse neuve, et le prix se paie en A9 : la lettre est
//      livrée, aucune des deux identités qu'une session sait dériver ne peut la
//      signer, et elle revient toutes les dix minutes POUR TOUJOURS. Une lettre
//      perdue transformée en lettre harcelante.
//      Le droit d'accuser se dérive donc de la MÊME résolution qui a servi à
//      livrer (`resolveRecipient`, réexpéditions comprises) : si le guichet a
//      jugé qu'une lettre m'appartient au point de me la faire porter, j'ai le
//      droit de la signer. Une seule source, jamais deux qui divergent.
//      Sa LARGEUR est exactement celle de la porte 3, et pour la même raison : le
//      guichet MCP ne dérive qu'une lignée, donc la lignée d'arrivée signe pour
//      la chaise que la résolution désigne. Elle ne franchit AUCUNE famille — un
//      voisin, une chaise sœur nommément écartée, une famille éteinte restent
//      refusés — et elle NOMME sa porte au journal, comme la 3.
//      ⚠️ ELLE N'ÉLARGIT QUE LES REFUS. Un refus des portes 1-3 garde son motif
//      quand celle-ci ne s'applique pas : deux gardes voisines ne doivent jamais
//      se couvrir l'une l'autre sous un motif faux.
//
// Tout le reste est refusé : une session étrangère, une lignée étrangère à la
// chaise destinataire, une chaise inconnue du registre, une fiche retirée du
// service, une lignée dont plus personne ne porte le nom, un accusé anonyme.
//
// EXPORTÉE depuis G1 (la garde d'identité du guichet MCP) : `server.js`
// rejoue exactement cette même question, DESTINATAIRE ET SIGNATAIRE INVERSÉS,
// pour vérifier un `self` déclaré avant de lui faire confiance — « la session
// dérivée a-t-elle le droit de porter le nom qu'elle déclare ? » est la MÊME
// famille (le nom dérivé, sa lignée, une chaise de sa lignée, OU toute adresse
// que la résolution lui ramène — ancien nom, adresse humaine, porte 4) que
// celle que cette fonction sait déjà trancher : `verifierIdentiteDeclaree`
// appelle CETTE fonction, ce n'est pas une réimplémentation qui pourrait
// diverger. Une seule résolution — c'est la loi du 13/08.
export function droitDAccuser(db, destinataire, agentId) {
  // Le nom qui DÉCIDE est le nom qui sera JOURNALISÉ : il ne se normalise
  // qu'une fois, ici, et repart avec le verdict. Trancher sur « B » puis écrire
  // « ␣␣B␣␣ » au journal, c'est un journal qui ne dit pas ce qui s'est passé.
  const signataire = String(agentId ?? "").trim() || null;
  if (!signataire) {
    return { autorise: false, signataire, raison: "anonymous ack: without a name, nobody is the recipient" };
  }

  const cible = String(destinataire ?? "");

  const verdict = portesNominales(db, cible, signataire);
  // La porte 4 n'ÉLARGIT que les refus : elle ne retire jamais un droit, et elle
  // ne masque jamais le motif d'un refus qu'elle ne sait pas rattraper.
  const ouvert = verdict.autorise ? verdict : porteDeLaResolution(db, cible, signataire);
  if (!ouvert) return verdict;
  return signataireNuVersUneChaise(db, cible, ouvert) || ouvert;
}

// UN SIGNATAIRE NU NE SIGNE JAMAIS VERS UNE CHAISE VIVANTE DE SESSION (fix
// round 2 de la boucle Task 12, re-revue r1, 28/09). UNE règle, ici, pour
// toutes les portes et toutes les formes d'adresse : un nom SANS `#` (une
// lignée nue, un ancien nom, une adresse humaine, un alias — ce qu'un client
// MCP sans fiche ou le CLI signe) n'est jamais propriétaire d'une adresse que
// le guichet mène à UNE chaise en service qui a une session et qui n'est pas
// lui : ni la lignée tenue par cette chaise (portes 1/4), ni la chaise
// nominative (porte 3), ni son adresse humaine, ni un alias vers elle. Ouvert
// avant : le client sans fiche relevait et accusait sous `lignée@nom`, et
// accusait nu une lettre à `lignée#session`. Coût A8 accepté : la lettre reste
// à sa vraie session. Ce qui reste signable par un nom nu : une adresse qui ne
// mène à aucune chaise de session (le client solo, sa fiche sans session, ou une
// lignée sans chaise vivante). Fix round 3 : une lignée AMBIGUË (plusieurs
// chaises, aucune désignée) est refusée aussi. Comme `droitDAccuser` sert aussi
// la vérification d'un `self` déclaré (sens inverse), la même règle interdit à
// un appelant nu de SE DÉCLARER une telle adresse pour relever.
function signataireNuVersUneChaise(db, cible, verdict) {
  const raison = nomNuTenuParUneChaise(db, cible, verdict.signataire);
  return raison ? { autorise: false, signataire: verdict.signataire, raison } : null;
}

// LA RÈGLE, EN UNE FONCTION (fix round 3, 28/09 : la lignée ambiguë aussi).
// Un nom nu (`nom`, sans `#`) n'agit en propriétaire — relève, accusé — que
// sur une adresse qui ne mène à AUCUNE chaise de session : sa propre fiche sans
// session, ou une lignée sans chaise vivante. Une, plusieurs, désignée ou non :
// une lignée ambiguë est exactement le cas multi-chaises d'une maison inconnue,
// et ses lettres TENUES sont les plus précieuses. Rend la raison du refus, ou
// null. Exportée : le guichet MCP (inbox et history d'un appelant sans chaise)
// et `valxos-inbox` (acteur nu) la posent aussi, jamais une deuxième règle.
export function nomNuTenuParUneChaise(db, adresse, nom = adresse) {
  const acteur = String(nom ?? "").trim();
  if (!acteur || acteur.includes(SEPARATEUR_INSTANCE)) return null;
  const resolution = resolveRecipient(db, String(adresse ?? ""));
  const chaises = (resolution.targets || []).filter((t) => t?.instance_session_id && t.id !== acteur);
  // Ceinture (N1) : une chaise marquée `offline` dont le processus est encore
  // la MÊME incarnation (heure de naissance qui correspond) tient toujours la
  // lignée — un statut que quelqu'un a pu écrire ne vaut pas un processus mort.
  const racine = String(resolution.alias || adresse || "").split(/[#@]/)[0];
  const lignees = new Set([racine, ...(resolution.targets || []).map((t) => t?.lineage).filter(Boolean)]);
  for (const lignee of lignees) {
    let horsService = [];
    try {
      horsService = db
        .prepare("SELECT * FROM peers WHERE lineage = ? AND instance_session_id IS NOT NULL AND status = 'offline'")
        .all(lignee);
    } catch { horsService = []; }
    for (const row of horsService) {
      if (row.id === acteur || chaises.some((c) => c.id === row.id)) continue;
      if (verdictDeChaise(row).raison === "meme-incarnation") chaises.push(row);
    }
  }
  if (chaises.length === 0) return null;
  const quelle = chaises.length > 1
    ? "live chairs (none designated)"
    : Number(chaises[0].is_primary) === 1 ? "the designated chair" : "a live chair";
  return `cc copy: this address leads to ${quelle} of the lineage. A signer without a chair (a bare name) holds only a copy: only that chair signs, from its own session`;
}

// LE REPÈRE NE SE VÉRIFIE JAMAIS LUI-MÊME. `verifierIdentiteDeclaree` tranche
// si un `self` DÉCLARÉ (une DEMANDE, jamais une identité) a le droit de
// porter le nom qu'il prétend — contre `derive`, la session qui appelle
// VRAIMENT (jamais reçue en argument : toujours dérivée de l'environnement
// PAR L'APPELANT, avant même d'arriver ici). EXPORTÉE (remède de la revue adverse #4) :
// le guichet MCP ET le CLI (`cc2cc-inbox`) en dérivent CHACUN leur `derive`,
// mais rejouent la MÊME vérification — jamais une deuxième qui pourrait
// diverger.
// ⚠️ `declare === derive` COURT-CIRCUITE `droitDAccuser` : le nom dérivé EST
// la session, la porte 1 (fiche retirée du service) n'achète rien à CETTE
// frontière-là. Avant ce court-circuit, deux chemins pour la MÊME identité
// rendaient deux verdicts : ne rien déclarer ressuscitait la fiche via
// `ensureSelf()`/`registerPeer` (statut posé « active ») et lisait, déclarer
// son propre nom EXACT tombait sur « destinataire retiré du service » — un
// appelant pouvait choisir son verdict rien qu'en omettant `self`. Les deux
// chemins rendent maintenant `declare: ""`, donc LE MÊME chemin ensuite.
export function verifierIdentiteDeclaree(db, derive, self) {
  const declare = String(self ?? "").trim();
  if (!declare || declare === derive) return { autorise: true, declare: "" };
  return { ...droitDAccuser(db, declare, derive), declare };
}

// La raison de la porte 2 est aussi la CLEF que lit `gardeDeLaCopie` : une
// seule chaîne, écrite une fois, pour que la traduction d'une prose ne
// débranche jamais une garde.
const RAISON_CHAISE_DE_LA_LIGNEE = "in-service instance of the recipient lineage";

// Les trois portes qui ne lisent que la FORME du nom. Elles restent le chemin
// nominal : c'est d'elles que viennent les motifs de refus précis.
function portesNominales(db, cible, signataire) {
  // 1. LE NOM EXACT du destinataire.
  if (signataire === cible) {
    const fiche = getInstance(db, signataire);
    if (fiche && !enService(fiche)) {
      return { autorise: false, signataire, raison: "recipient retired from service" };
    }
    return { autorise: true, signataire, raison: "recipient" };
  }

  // 2. Une CHAISE signe pour SA lignée.
  if (signataire.includes(SEPARATEUR_INSTANCE)) {
    const lignee = signataire.split(SEPARATEUR_INSTANCE)[0];
    if (lignee !== cible) {
      return { autorise: false, signataire, raison: "neither the recipient nor an instance of the recipient lineage" };
    }
    const chaise = getInstance(db, signataire);
    if (!chaise) return { autorise: false, signataire, raison: "chair unknown to the registry" };
    if (!enService(chaise)) return { autorise: false, signataire, raison: "chair retired from service" };
    return { autorise: true, signataire, raison: RAISON_CHAISE_DE_LA_LIGNEE };
  }

  // 3. Une LIGNÉE signe pour une chaise de SA lignée. ⚠️ Fix round 2 de la
  //    boucle Task 12 : plus jamais vers une chaise EN SERVICE avec session —
  //    `signataireNuVersUneChaise` le refuse dans `droitDAccuser`. Cette porte
  //    ne sert plus qu'à une chaise que le guichet ne mène nulle part.
  if (cible.includes(SEPARATEUR_INSTANCE)) {
    if (cible.split(SEPARATEUR_INSTANCE)[0] !== signataire) {
      return { autorise: false, signataire, raison: "lineage foreign to the recipient chair" };
    }
    if (!ligneeEnService(db, signataire)) {
      return { autorise: false, signataire, raison: "lineage without a chair in service" };
    }
    return { autorise: true, signataire, raison: "lineage of the recipient (the office does not derive the chair)" };
  }

  return { autorise: false, signataire, raison: "neither the recipient nor an instance of the recipient lineage" };
}

// LA PORTE 4 — la seule qui pose au guichet la question qu'il a déjà tranchée
// pour livrer : « à qui cette adresse mène-t-elle ? ». Rend un verdict AUTORISÉ,
// ou `null` — jamais un refus : les motifs de refus appartiennent aux portes
// nominales, qui savent nommer précisément ce qui a mordu.
//
// Les cibles rendues par `resolveRecipient` sont déjà EN SERVICE par
// construction (les trois marches filtrent `EN_SERVICE` — ni `offline` ni `dead`) : une chaise
// hors service n'est jamais une cible, donc jamais une signataire par ici.
function porteDeLaResolution(db, cible, signataire) {
  const resolution = resolveRecipient(db, cible);
  for (const target of resolution.targets) {
    // La CHAISE que le guichet désigne : elle signe pour elle-même.
    if (target.id && target.id === signataire) {
      return { autorise: true, signataire, raison: "the chair the office routes this address to" };
    }
    // Sa LIGNÉE : le guichet MCP ne dérive que ce nom-là (voir porte 3).
    if (target.lineage && target.lineage === signataire) {
      return { autorise: true, signataire, raison: "the lineage the office routes this address to" };
    }
  }
  return null;
}

// LA COPIE NE SE SIGNE PAS (Run 6, Task 7, 27/09). Observé ce jour : une instance
// sœur a accusé une lettre de la lignée À LA PLACE de la chaise désignée — par la
// porte 2 (« une chaise signe pour SA lignée »), qui ne demandait jamais
// laquelle. Désormais, quand une CHAISE nommée signe une lettre adressée à sa
// LIGNÉE, on pose au guichet la question qui a servi à livrer : si la lignée
// mène à une AUTRE chaise, cette chaise-ci n'en tenait qu'une copie cc ; si elle
// ne mène à personne (ambiguë), la lettre est tenue pour la lignée. Refus
// motivé dans les deux cas, lettre intacte (A9).
// ⚠️ PORTÉE : seule la porte 2 est resserrée, et seulement pour ACCUSER.
// `verifierIdentiteDeclaree` appelle `droitDAccuser` sans cette garde : se
// DÉCLARER sa lignée reste permis, c'est signer la copie qui ne l'est pas. Le
// nom de lignée NU (ce que le guichet MCP dérive, faute de session) reste le
// destinataire exact, porte 1, tant que sa lignée ne mène à aucune chaise en
// service avec session ; dès qu'elle y mène, le nom nu n'a qu'une copie et la
// chaise signe (règle du 28/09/2026, `nomNuTenuParUneChaise`).
//
// FIX 1 (revue Task 7, sonde 7) — LA PORTE 1 AUSSI, pour un signataire SANS
// chaise. Le nom de lignée NU (un client MCP sans fiche de session, le CLI)
// signait la lettre de sa lignée comme « destinataire exact » — la porte même
// par laquelle l'instance est passée cet après-midi. Désormais : si la lignée
// mène à UNE chaise vivante avec session, un signataire nu n'en a qu'une
// copie, et le refus le dit (depuis le fix round 2 : `signataireNuVersUneChaise`,
// dans `droitDAccuser`, pour toutes les formes d'adresse).
// F3 (passe adverse, 28/09) : désignée OU NON. Fermer la porte seulement
// devant une chaise désignée laissait un jumeau refusé, ou un client nu, signer
// la lettre que le guichet menait à la seule chaise d'une lignée jamais
// désignée — l'état par défaut de toute lignée d'un inconnu. Un client SOLO (sa
// seule fiche, sans session) garde le geste d'avant à l'identique. Depuis le fix
// round 3, la lignée AMBIGUË n'est plus signable par le nom nu non plus
// (`nomNuTenuParUneChaise`).
function gardeDeLaCopie(db, destinataire, verdict) {
  // Le signataire NU (porte 1) est tranché plus haut, pour toutes les formes
  // d'adresse : `signataireNuVersUneChaise` (fix round 2).
  if (!verdict.autorise || verdict.raison !== RAISON_CHAISE_DE_LA_LIGNEE) return verdict;
  const chaise = getInstance(db, verdict.signataire);
  const decision = deciderLaCopie({
    lignee: String(destinataire ?? ""),
    sessionId: chaise?.instance_session_id || null,
    resolution: resolveRecipient(db, destinataire)
  });
  if (!decision.copie) return verdict;
  const raison = decision.sans_chaise_designee
    ? "lineage letter held (sans-chaise-designee): no designated chair holds it as its own. Designate a chair (valxos-chaise designer), or harvest (valxos-chaise moissonner) if only one live chair remains"
    : `cc copy: the lineage's letter belongs to the designated chair (${decision.chaise_designee}); this chair holds only a copy`;
  return { autorise: false, signataire: verdict.signataire, raison };
}

// `at` est l'horloge du geste, et elle s'injecte comme celle des deux autres
// marques (`markCarried`, `markDelivered`). Ce n'est pas un confort de test :
// SANS elle, la garde `COALESCE` ci-dessous n'est prouvable par personne. Deux
// accusés consécutifs tombent dans la même milliseconde, donc la réécriture rend
// exactement la même chaîne que le figeage — un test qui compare les deux dates
// est vert QUOI QUE FASSE le code. L'horloge murale ne sépare pas deux appels
// qui se suivent : on ne lui demande donc rien.
export function ackMessage(db, msgId, agentId, { at = null } = {}) {
  const row = getMessageById(db, msgId);
  if (!row) return null;

  const verdict = gardeDeLaCopie(db, row.recipient, droitDAccuser(db, row.recipient, agentId));
  if (!verdict.autorise) {
    // Le refus NE MODIFIE RIEN : la lettre garde son `acked_at` nul, donc son
    // droit au retour (A9). Il n'est pas muet non plus — un refus qu'on ne peut
    // pas relire est un état que personne ne saura jamais nommer.
    recordEvent(db, msgId, verdict.signataire, "accuse_refuse", {
      refus: "accuse-refuse-lettre",
      destinataire: row.recipient,
      raison: verdict.raison
    });
    throw new AccuseRefuse(msgId, verdict.signataire, row.recipient, verdict.raison);
  }

  db.prepare("UPDATE messages SET acked_at = COALESCE(acked_at, ?) WHERE msg_id = ?").run(at || nowIso(), msgId);
  // La raison voyage jusqu'au journal : c'est ce qui rend la porte 3 auditable.
  // Sans elle, un accusé signé d'un nom de lignée serait indiscernable d'un
  // accusé signé par la chaise elle-même.
  recordEvent(db, msgId, verdict.signataire, "acked", { titre: verdict.raison });
  return getMessageById(db, msgId);
}

export function registerPeer(db, input) {
  const id = input.id;
  if (!id) throw new Error("registerPeer requires id");
  const payload = {
    id,
    project_path: input.project_path || input.projectPath || null,
    description: input.description || "",
    session_id: input.session_id || input.sessionId || null,
    pid: Number.isFinite(Number(input.pid)) ? Number(input.pid) : process.ppid,
    hostname: input.hostname || os.hostname(),
    model: input.model || null,
    status: input.status || "active",
    registered_at: input.registered_at || nowIso(),
    last_seen: nowIso(),
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null
  };
  db.prepare(`
    INSERT INTO peers (
      id, project_path, description, session_id, pid, hostname, model,
      status, registered_at, last_seen, metadata_json
    )
    VALUES (
      @id, @project_path, @description, @session_id, @pid, @hostname, @model,
      @status, @registered_at, @last_seen, @metadata_json
    )
    ON CONFLICT(id) DO UPDATE SET
      project_path = COALESCE(excluded.project_path, peers.project_path),
      description = COALESCE(NULLIF(excluded.description, ''), peers.description),
      session_id = COALESCE(excluded.session_id, peers.session_id),
      pid = COALESCE(excluded.pid, peers.pid),
      hostname = COALESCE(excluded.hostname, peers.hostname),
      model = COALESCE(excluded.model, peers.model),
      status = excluded.status,
      -- I-6 (18/10) : la même règle que registerInstance. Une fiche nue qui se
      -- ré-enregistre est une fiche qui parle ; le constat de mort s'efface
      -- avec l'état qu'il datait.
      dead_at = NULL,
      last_seen = excluded.last_seen,
      metadata_json = COALESCE(excluded.metadata_json, peers.metadata_json)
  `).run(payload);
  writeHeartbeat(payload);
  return getPeer(db, id);
}

export function writeHeartbeat(peer) {
  const file = runtimePaths(peer.id).heartbeat;
  writeJsonAtomic(file, {
    agent: peer.id,
    timestamp: peer.last_seen || nowIso(),
    session_id: peer.session_id || null,
    pid: peer.pid || null,
    status: peer.status || "active",
    project_path: peer.project_path || null,
    description: peer.description || "",
    hostname: peer.hostname || os.hostname(),
    model: peer.model || null
  });
}

export function getPeer(db, id) {
  return db.prepare("SELECT * FROM peers WHERE id = ?").get(id);
}

export function getPeerBySessionId(db, sessionId) {
  if (!sessionId) return null;
  return db.prepare("SELECT * FROM peers WHERE session_id = ? ORDER BY last_seen DESC LIMIT 1").get(sessionId);
}

// Les chaises du registre. Par défaut, CELLES QUI REÇOIVENT : lister une chaise
// morte comme si elle était vivante, c'est ce qui a fait écrire vingt-neuf
// chaises d'une même lignée là où une seule répondait. `includeDead` rend la
// vue complète — rien n'a disparu, Camp B, et c'est ce que montre `cc2cc-peers --all`.
export function listPeers(db, { includeDead = false } = {}) {
  const clause = includeDead ? "" : `WHERE ${EN_SERVICE}`;
  return db.prepare(`SELECT * FROM peers ${clause} ORDER BY id ASC`).all();
}

// Camp B constitutionnel (décision 20/08) : une seule voie possible, marquer
// hors service. La voie destructive (DELETE FROM peers) a existé ici — elle
// contredisait le README et la skill chaise, qui promettent tous deux que
// rien ne s'efface. Elle est retirée, pas remplacée : aucune option ne rouvre
// ce chemin, y compris pour un appelant qui passerait encore l'ancien nom.
export function unregisterPeer(db, id, detail = {}) {
  const peer = getPeer(db, id);
  if (!peer) return null;
  db.prepare("UPDATE peers SET status = 'offline', last_seen = ? WHERE id = ?").run(nowIso(), id);
  const updated = getPeer(db, id);
  writeHeartbeat(updated);
  recordEvent(db, null, id, "peer_unregistered", detail);
  return updated;
}

// ON NE DÉSINSCRIT PAS LA CHAISE D'UN AUTRE (N1, seconde passe adverse,
// 28/09). N'importe quel client MCP passait une chaise vivante et confirmée
// `offline` ; la lignée retombait sur la fiche nue, et le même client relevait
// puis accusait la lettre de la vraie session — toute la garde du nom nu
// repose sur « une chaise vivante de session ». Une chaise (`lignée#session`,
// avec session) ne se retire que par elle-même (`appelant`, la chaise que la
// fiche de l'appelant dérive) ou quand son processus est MORT
// (`verdictDeChaise`). Vivante, indécidable ou sans heure de naissance : refus
// (on préfère une chaise de trop à une lettre prise). Une fiche sans session
// n'est pas concernée. Rend `{ autorise, raison }`.
// Les verdicts de `verdictDeChaise` sont des CODES, lus ailleurs tels quels ;
// la raison d'un refus est une phrase que l'opérateur lit : elle les dit en
// anglais, et un code inconnu passe tel quel plutôt que de se taire.
const VERDICT_LISIBLE = { vivante: "alive", indecidable: "undecidable" };
const RAISON_LISIBLE = {
  "meme-incarnation": "same incarnation",
  "pid-vivant": "process alive, no birth time recorded",
  "sans-pid": "no pid",
  "sonde-impossible": "probe impossible"
};
export function verdictDeDesinscription(db, id, { appelant = null, deps = {} } = {}) {
  const nom = String(id ?? "").trim();
  if (!nom.includes(SEPARATEUR_INSTANCE)) return { autorise: true, raison: "card without a chair" };
  const chaise = getPeer(db, nom);
  if (!chaise || !chaise.instance_session_id) return { autorise: true, raison: "card without a session" };
  if (appelant && appelant === nom) return { autorise: true, raison: "the chair itself" };
  const verdict = verdictDeChaise(chaise, deps);
  if (verdict.etat === "morte") return { autorise: true, raison: `process dead (${verdict.raison})` };
  return {
    autorise: false,
    raison: `chair verdict: ${VERDICT_LISIBLE[verdict.etat] ?? verdict.etat} (${RAISON_LISIBLE[verdict.raison] ?? verdict.raison}): only the chair itself, from its own session, or the death of its process takes it out of service`
  };
}

// L'HISTORIQUE EST UNE BOÎTE, PAS LA TABLE : `self` borne TOUJOURS la
// requête, dans les TROIS branches — un appelant sans lettre EN COMMUN avec
// personne ne doit jamais recevoir le courrier de deux autres. C'était le
// trou (finding réviseur, G1 round 1) : `thread_id` REMPLAÇAIT le filtre
// `self` au lieu de s'y AJOUTER, et l'absence de `peer` rendait la TABLE
// ENTIÈRE, corps des lettres compris. Un seul appelant existe (le guichet
// MCP, server.js) et lui passe désormais toujours une identité VÉRIFIÉE —
// mais la fonction ne doit pas dépendre de la discipline de son appelant :
// une boîte sans identité ne rend rien, jamais la table par défaut.
// UN ALIAS N'HÉRITE PAS DU PASSÉ DU NOM (F8, passe adverse, 28/09). Sous un
// nom déposé au registre des anciens noms (alias ou renvoi), l'historique est
// borné aux lettres d'APRÈS son `depose_at` : `valxos-chaise alias bob
// mallory` donnait à mallory toute la correspondance que bob avait eue avec
// des tiers avant que l'alias n'existe — et pour un client MCP en bac à sable
// (qui ne lit pas le fichier du bureau), ce guichet est la seule surface.
function borneDuNom(db, nom) {
  try {
    return db.prepare("SELECT depose_at FROM anciens_noms WHERE ancien_nom = ?").get(nom)?.depose_at || null;
  } catch {
    return null;
  }
}

export function history(db, { self, peer, thread_id = null, limit = 50 } = {}) {
  const moi = String(self || "").trim();
  if (!moi) return [];
  const borne = borneDuNom(db, moi);
  const apres = borne ? " AND created_at > ?" : "";
  const avecBorne = (...valeurs) => (borne ? [...valeurs, borne] : valeurs);

  if (thread_id) {
    return db
      .prepare(`
        SELECT * FROM messages
        WHERE thread_id = ? AND (sender = ? OR recipient = ?)${apres}
        ORDER BY seq DESC
        LIMIT ?
      `)
      .all(...avecBorne(thread_id, moi, moi), limit);
  }
  if (peer) {
    return db
      .prepare(`
        SELECT * FROM messages
        WHERE ((sender = ? AND recipient = ?)
           OR (sender = ? AND recipient = ?))${apres}
        ORDER BY seq DESC
        LIMIT ?
      `)
      .all(...avecBorne(moi, peer, peer, moi), limit);
  }
  return db
    .prepare(`SELECT * FROM messages WHERE (sender = ? OR recipient = ?)${apres} ORDER BY seq DESC LIMIT ?`)
    .all(...avecBorne(moi, moi), limit);
}

export function recordEvent(db, msgId, agentId, eventType, detail = {}) {
  db.prepare(`
    INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json)
    VALUES (?, ?, ?, ?)
  `).run(msgId || null, agentId || null, eventType, JSON.stringify(detail));
}

// L'ALIAS SE JOURNALISE UNE FOIS PAR LETTRE (27/09). Une lettre venue par un
// alias prioritaire doit pouvoir se relire au journal — « adressée à X, portée
// à Y » — sinon la trajectoire est invisible. Une fois, pas à chaque tournée :
// le guichet la note au dépôt, le Facteur la note s'il la voit le premier (une
// lettre déposée AVANT que l'alias ne soit posé), et la garde est la base
// elle-même, jamais un drapeau en mémoire. Ne rend rien, ne lève jamais : un
// journal qui ferme la porte au courrier serait pire que pas de journal.
// `resolution` est la résolution déjà faite (le guichet l'a en main) ou une
// FONCTION qui la calcule : les chemins de lecture passent la fonction, pour
// que la résolution elle-même tourne DANS ce try (hygiène H6 — un
// `resolveRecipient` qui levait, calculé par l'appelant, cassait la relève).
export function journaliserAlias(db, lettre, resolution, agentId = null) {
  if (!lettre?.msg_id) return false;
  try {
    if (typeof resolution === "function") resolution = resolution();
    if (!resolution?.alias) return false;
    const deja = db
      .prepare("SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = 'alias_applique' LIMIT 1")
      .get(lettre.msg_id);
    if (deja) return false;
    recordEvent(db, lettre.msg_id, agentId || lettre.sender || null, "alias_applique", {
      demande: lettre.recipient,
      alias: resolution.alias,
      resolution: resolution.kind,
      cibles: (resolution.targets || []).map((c) => c.id)
    });
    return true;
  } catch {
    return false;
  }
}

// ── alias_applique SUR LE CHEMIN DE LECTURE (Run 6, Task 6) ─────────────────
// Le repli des hooks (`adressesDuRepli`) relève une lettre adressée à un
// ALIAS quand le guichet la ramène à la chaise courante. Une lettre déposée
// avant l'alias et servie SEULEMENT par ce chemin n'avait aucune ligne de
// journal : le Facteur était le seul à la poser. Ici, chaque lettre lue dont la
// racine d'adresse est un alias reçoit sa ligne — une seule, `journaliserAlias`
// garde l'unicité par lettre, quel que soit le chemin qui la pose en premier.
// Coût borné : une requête quand le bureau n'a aucun alias (le cas courant).
export function journaliserLesAliasLus(db, lettres, agentId = null) {
  if (!Array.isArray(lettres) || lettres.length === 0) return 0;
  let alias;
  try {
    alias = new Set(
      db.prepare("SELECT ancien_nom FROM anciens_noms WHERE prioritaire = 1").all().map((r) => r.ancien_nom)
    );
  } catch {
    return 0;
  }
  if (alias.size === 0) return 0;
  let poses = 0;
  for (const lettre of lettres) {
    const adresse = String(lettre?.recipient || "");
    const coupe = adresse.search(/[@#]/);
    const racine = coupe > 0 ? adresse.slice(0, coupe) : adresse;
    if (!alias.has(racine)) continue;
    if (journaliserAlias(db, lettre, () => resolveRecipient(db, adresse), agentId)) poses += 1;
  }
  return poses;
}
