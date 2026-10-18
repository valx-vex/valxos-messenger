// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// Les vrais noms : une lignée, des instances, et une chaise désignée.
//
// Une LIGNÉE est un nom qu'on appelle (« alice », « bob »). Une INSTANCE est
// une session vivante de cette lignée. La clé d'une instance est son sessionId,
// jamais son PID : un PID se recycle, une session non.
//
// Règle qui commande tout le reste : une lignée à plusieurs instances vivantes ne
// se tranche JAMAIS toute seule. « La plus récente gagne » est un tirage au sort
// déguisé, et le prix du tirage, c'est une lettre lue par la mauvaise personne.
// Le seul moyen de trancher est `designatePrimary` — un geste humain.

import os from "node:os";
import { nowIso } from "./config.js";
// Les deux sondes de vivacité de la maison, écrites et éprouvées pour le
// Facteur. On ne les réécrit PAS ici : deux implémentations de « ce processus
// est-il vivant ? » finissent toujours par diverger, et le jour où elles
// divergent, l'une des deux perd du courrier.
import { isProcessAlive, procStartOf } from "./postbox.js";

export const SEPARATEUR_INSTANCE = "#";

// ── EN SERVICE : les deux façons de quitter le service ──────────────────────
//
// `offline` est un geste HUMAIN (`unregister`) : « cette chaise ne reçoit plus ».
// `dead` est un CONSTAT de la moisson : plus aucun processus ne tient la chaise.
// Les deux sortent du service, aucun des deux n'efface quoi que ce soit — Camp B,
// la ligne reste en base avec son heure.
//
// ⚠️ CETTE CLAUSE EST LA RAISON D'ÊTRE DE LA MOISSON. Marquer une chaise `dead`
// sans l'écrire ICI ne changerait strictement RIEN : les trois marches de la
// résolution continueraient de la compter, et vingt-neuf homonymes morts
// rendraient toujours « ambigu » — c'est-à-dire une lettre qui attend un
// arbitrage que plus personne ne peut rendre. Le verdict ne vaut que là où on
// le lit.
export const STATUTS_HORS_SERVICE = ["offline", "dead"];
export const EN_SERVICE = "status NOT IN ('offline', 'dead')";

// ── L'ADRESSE HUMAINE : `lignée@nom-de-session` ─────────────────────────────
//
// `claude-alice#00000000-0000-4000-8000-000000000000` est une adresse exacte et
// illisible : personne ne la tape. Or les sessions ont DÉJÀ un nom humain
// (« atelier », « veille ») — c'est le vocabulaire de l'humain et celui du
// harnais natif. On l'adopte, sans rien retirer : l'identifiant technique et le
// nom de lignée seul continuent de marcher, au même endroit qu'avant.
//
// Pourquoi « @ » :
//   ① il se lit « quelqu'un CHEZ quelque part » — c'est exactement le sens ;
//   ② il n'est PAS « # » : une adresse ne peut jamais être confondue avec
//      l'autre, et une faute de frappe entre les deux ne peut pas silencieusement
//      désigner quelqu'un d'autre ;
//   ③ il traverse la chaîne d'envoi intact (`cc2cc-send --to` n'assainit pas le
//      destinataire ; seul le nom de FICHIER d'un pair est assaini).
// On coupe au PREMIER « @ » : la lignée est un mot du registre, le nom de
// session est du texte tapé par un humain — c'est lui qui a le droit d'être
// bizarre.
export const SEPARATEUR_SESSION = "@";

const COLONNES_INSTANCE = `
  id, lineage, house, instance_session_id, session_id, pid, proc_start,
  project_path, model, hostname, description, status, session_name,
  registered_at, last_seen, heartbeat_at
`;

// Un nom de session se compare à la MAIN de l'humain, pas à l'octet : « Atelier 2 »,
// « atelier 2 » et « atelier   2 » sont le même nom. Une normalisation ne peut
// JAMAIS faire livrer à côté : quand elle rapproche deux boîtes, la résolution
// rend « ambigu » et la lettre attend — elle ne désigne jamais un gagnant.
function nomDeSessionNormalise(nom) {
  return String(nom ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Ce qu'on GARDE en base : le nom tel que l'humain l'écrit (casse comprise),
// juste débarrassé de ses bords. On range le nom, on ne le réécrit pas.
function nomDeSessionLisible(nom) {
  const propre = String(nom ?? "").trim().replace(/\s+/g, " ");
  return propre || null;
}

// Le nom d'une chaise porte la session ENTIÈRE. Raccourcir la session ferait
// partager une même chaise à deux personnes vivantes dont les identifiants
// commencent pareil — et le pire n'est pas la collision : c'est que le guichet
// cesserait alors de dire « ambigu » pour rendre UNE cible, c'est-à-dire une
// certitude fausse. Un tirage aux dés silencieux est pire qu'un aveu d'ambiguïté.
export function instanceId(lineage, sessionId) {
  return `${lineage}${SEPARATEUR_INSTANCE}${String(sessionId)}`;
}

export function getInstance(db, id) {
  return db.prepare("SELECT * FROM peers WHERE id = ?").get(id);
}

export function getInstanceBySession(db, sessionId) {
  if (!sessionId) return null;
  return db.prepare("SELECT * FROM peers WHERE instance_session_id = ?").get(sessionId) || null;
}

// Les instances en service d'une lignée. Une instance retirée du service
// (`offline`) reste en base — Camp B — mais ne reçoit plus de courrier.
export function listInstances(db, lineage, { includeOffline = false } = {}) {
  const clause = includeOffline ? "" : `AND ${EN_SERVICE}`;
  return db
    .prepare(`
      SELECT * FROM peers
      WHERE lineage = ? AND instance_session_id IS NOT NULL ${clause}
      ORDER BY registered_at ASC, id ASC
    `)
    .all(lineage);
}

export function registerInstance(db, input = {}) {
  const lineage = String(input.lineage || input.lignee || "").trim();
  if (!lineage) throw new Error("registerInstance requires a lineage");
  const sessionId = String(input.sessionId || input.session_id || "").trim();
  if (!sessionId) {
    throw new Error("registerInstance requires a session: the instance IS the session, and a PID gets recycled");
  }

  const id = instanceId(lineage, sessionId);
  const now = input.now || nowIso();
  const charge = {
    id,
    lineage,
    house: input.house || null,
    instance_session_id: sessionId,
    session_id: sessionId,
    pid: Number.isFinite(Number(input.pid)) ? Number(input.pid) : null,
    proc_start: input.procStart || input.proc_start || null,
    project_path: input.projectPath || input.project_path || null,
    // Déclaratif, jamais une source de vérité : le modèle qui compte voyage
    // avec la lettre (`messages.sender_model`).
    model: input.model || null,
    hostname: input.hostname || os.hostname(),
    description: input.description || "session",
    status: input.status || "active",
    // Le nom humain de la session. Inconnu se dit NULL — un nom ne s'invente
    // pas, et une adresse `lignée@nom` qui ne trouve personne vaut mieux qu'une
    // adresse qui trouve quelqu'un d'autre.
    session_name: nomDeSessionLisible(input.sessionName || input.session_name),
    now
  };

  db.prepare(`
    INSERT INTO peers (${COLONNES_INSTANCE})
    VALUES (
      @id, @lineage, @house, @instance_session_id, @session_id, @pid, @proc_start,
      @project_path, @model, @hostname, @description, @status, @session_name,
      @now, @now, @now
    )
    ON CONFLICT(id) DO UPDATE SET
      lineage = excluded.lineage,
      house = COALESCE(excluded.house, peers.house),
      instance_session_id = excluded.instance_session_id,
      session_id = excluded.session_id,
      pid = COALESCE(excluded.pid, peers.pid),
      -- Un AUTRE pid, c'est un autre processus : son heure de naissance ne
      -- s'hérite pas (Task 6, fix 1). Garder l'ancienne sous un pid neuf, ce
      -- serait fabriquer une identité que personne n'a observée.
      proc_start = CASE
        WHEN excluded.pid IS NOT NULL AND excluded.pid IS NOT peers.pid THEN excluded.proc_start
        ELSE COALESCE(excluded.proc_start, peers.proc_start)
      END,
      project_path = COALESCE(excluded.project_path, peers.project_path),
      model = COALESCE(excluded.model, peers.model),
      description = COALESCE(NULLIF(excluded.description, ''), peers.description),
      -- Un renommage (la commande /rename) se voit au battement suivant. Un nom qu'on n'a
      -- PAS pu lire (fiche absente, maison inconnue) n'efface pas celui qu'on
      -- connaissait : perdre le nom, ce serait perdre l'adresse avec.
      session_name = COALESCE(excluded.session_name, peers.session_name),
      status = excluded.status,
      -- SE RÉ-ANNONCER, C'EST RESSUSCITER. Une chaise moissonnée à tort (sonde
      -- trompée, PID relu de travers) redevient vivante d'elle-même au geste
      -- suivant de sa session : c'est ce qui rend la moisson sûre. Le constat de
      -- mort s'efface avec l'état qu'il datait — le garder ferait mentir la
      -- colonne sur une chaise qui parle.
      dead_at = NULL,
      last_seen = excluded.last_seen,
      heartbeat_at = excluded.heartbeat_at
  `).run(charge);
  // `is_primary` n'est jamais touché ici : se ré-annoncer ne prend pas la chaise
  // et ne la rend pas non plus.
  return getInstance(db, id);
}

// Le battement : l'instance dit « je suis encore là ». Aucune autre fiche ne bouge.
export function beat(db, sessionId, at = nowIso()) {
  if (!sessionId) return 0;
  const res = db
    .prepare("UPDATE peers SET heartbeat_at = ?, last_seen = ? WHERE instance_session_id = ?")
    .run(at, at, sessionId);
  return res.changes;
}

// ── LA MOISSON : le registre inscrit enfin les départs ──────────────────────
//
// Le défaut, vu en production le 18/08 : `cc2cc-peers` annonçait 43 chaises
// toutes « active », dont trois seulement avaient un processus derrière. Une
// seule lignée en comptait vingt-neuf à elle seule — la résolution
// rendait « ambigu » et le courrier de la famille attendait un arbitrage que
// personne ne pouvait rendre. Le registre inscrivait les naissances et
// n'inscrivait jamais les morts.
//
// ⚠️ LA MOISSON NE REGARDE PAS L'HEURE, ET C'EST DÉLIBÉRÉ.
// `heartbeat_at` dit quand la chaise a été vue pour la dernière fois. Sur ce
// bureau c'est une OBSERVATION et ça ne l'a jamais été davantage : aucune
// requête, nulle part, ne compare un battement à un seuil — il s'affiche dans
// `cc2cc-chaise` (« vue : … »), rien de plus. On ne lui fait pas dire ici ce
// qu'il n'a jamais dit. Un silence n'est pas une mort : une session qui n'a
// rien fait depuis deux heures est vivante et attend son courrier, et la
// moissonner sur son silence serait exactement la faute que ce bureau passe son
// temps à refuser — deviner. Ce qu'on vérifie est un FAIT observable : le
// processus existe, et c'est le même.

function normaliserNaissance(valeur) {
  return String(valeur).replace(/\s+/g, " ").trim();
}

// TROIS ISSUES, JAMAIS DEUX. « Je n'ai pas pu savoir » n'est pas « elle est
// morte » : une sonde qui n'a pas pu tourner ne condamne personne.
//   vivante      → la chaise reste en service
//   morte        → on la moissonne, et on dit de quoi
//   indecidable  → ON S'ABSTIENT, et le rapport la compte à part
export function verdictDeChaise(row, deps = {}) {
  const estVivant = deps.isProcessAlive || isProcessAlive;
  const heureDeDemarrage = deps.procStartOf || procStartOf;

  const pid = Number(row?.pid);
  // L'amendement A5 de `postbox.js`, appliqué ici : sans numéro utilisable, on
  // ne conclut pas. Une fiche héritée de v1 n'a jamais porté de PID ; la
  // déclarer morte retirerait de la circulation une adresse dont on ne sait
  // rien. On s'abstient — et on le DIT, parce qu'une abstention muette est un
  // état que personne ne saura jamais lire.
  if (!Number.isInteger(pid) || pid <= 1) return { etat: "indecidable", raison: "sans-pid" };

  if (!estVivant(pid)) return { etat: "morte", raison: "processus-parti" };

  // Le numéro vit — mais est-ce le MÊME processus ? Sans heure de naissance
  // inscrite, la question n'a pas de réponse et on GARDE la chaise : entre se
  // tromper de sens, on choisit celui qui ne perd pas de courrier.
  const inscrite = row.proc_start ? String(row.proc_start) : "";
  if (!inscrite) return { etat: "vivante", raison: "pid-vivant" };

  const observee = heureDeDemarrage(pid);
  // `ps` muet : la sonde n'a pas tourné. Ni un succès, ni une condamnation.
  if (!observee) return { etat: "indecidable", raison: "sonde-impossible" };

  return normaliserNaissance(observee) === normaliserNaissance(inscrite)
    ? { etat: "vivante", raison: "meme-incarnation" }
    : { etat: "morte", raison: "pid-recycle" };
}

// Passer le registre en revue et inscrire les morts. Camp B, sans exception :
// AUCUN DELETE ici, ni ailleurs dans cette fonction. On marque, on date, on
// laisse la ligne — une chaise morte reste lisible pour toujours, et
// `--all` la montre.
// LE RAPPORT ET LA MOISSON (Run 6, Task 8) : `dryRun` compte les candidates
// sans rien marquer ni tracer — c'est la lecture du médecin. Seuls les deux
// gestes explicites de l'opérateur (`valxos-doctor --reap`, `valxos-chaise
// moissonner`) appellent la moisson qui écrit.
export function reapDeadPeers(db, { now = nowIso(), dryRun = false, ...deps } = {}) {
  const mode = dryRun ? "rapport" : "moisson";
  let chaises;
  try {
    chaises = db.prepare(`SELECT * FROM peers WHERE ${EN_SERVICE}`).all();
  } catch {
    // Un bureau sans table `peers` (migration partielle) n'est pas une panne de
    // la moisson : il n'y a simplement rien à moissonner. Le courrier continue.
    return { checked: 0, reaped: 0, abstained: 0, moissonnees: [], abstenues: [], mode };
  }

  const moissonnees = [];
  const abstenues = [];
  // Le constat ne se pose que sur la ligne TELLE QU'ON L'A LUE : toujours en
  // service, même dernière vue, même dernier battement. Une autre moisson l'a
  // déjà marquée ? Une ré-annonce l'a ramenée ? Alors notre lecture est
  // périmée, pas la chaise — zéro ligne touchée, zéro trace, zéro compte.
  const marquer = db.prepare(`
    UPDATE peers SET status = 'dead', dead_at = ?
    WHERE id = ? AND ${EN_SERVICE}
      AND pid IS ? AND proc_start IS ? AND last_seen IS ? AND heartbeat_at IS ?
  `);
  // La trace se pose à la main : `recordEvent` vit dans `database.js`, qui
  // importe CE module — l'appeler d'ici fermerait le cycle. Le `msg_id` nul est
  // légitime, la colonne l'autorise depuis l'origine : une chaise n'est pas une
  // lettre.
  const tracer = db.prepare(`
    INSERT INTO delivery_events (msg_id, agent_id, event_type, detail_json)
    VALUES (NULL, ?, 'peer_reaped', ?)
  `);

  const tx = db.transaction(() => {
    for (const chaise of chaises) {
      const { etat, raison } = verdictDeChaise(chaise, deps);
      if (etat === "vivante") continue;
      if (etat === "indecidable") {
        abstenues.push({ id: chaise.id, pid: chaise.pid ?? null, raison });
        continue;
      }
      if (dryRun) {
        // Candidate constatée, rien d'écrit : ni statut, ni trace.
        moissonnees.push({ id: chaise.id, pid: chaise.pid ?? null, raison });
        continue;
      }
      const posé = marquer.run(
        now, chaise.id,
        chaise.pid ?? null, chaise.proc_start ?? null, chaise.last_seen ?? null, chaise.heartbeat_at ?? null
      );
      if (posé.changes === 0) continue;
      moissonnees.push({ id: chaise.id, pid: chaise.pid ?? null, raison });
      tracer.run(chaise.id, JSON.stringify({ raison, pid: chaise.pid ?? null, dead_at: now }));
    }
  });
  tx();

  return {
    checked: chaises.length,
    reaped: moissonnees.length,
    abstained: abstenues.length,
    moissonnees,
    abstenues,
    mode
  };
}

// LA FICHE LISIBLE (Run 6, Task 8) : ce qu'un humain ou un agent reconnaît
// d'un coup d'œil — `lignée#session` courte, le nom de session, l'adresse
// humaine `lignée@nom`, et si la chaise est désignée. Elle AJOUTE ces champs,
// elle n'en retire aucun. Une fiche héritée sans session garde son id.
export function ficheLisible(peer) {
  const lignee = peer?.lineage || null;
  const session = peer?.instance_session_id ? String(peer.instance_session_id) : null;
  return {
    ...peer,
    chaise: lignee && session ? `${lignee}${SEPARATEUR_INSTANCE}${session.slice(0, 8)}` : peer?.id,
    nom: peer?.session_name || null,
    adresse_humaine: lignee && peer?.session_name ? `${lignee}${SEPARATEUR_SESSION}${peer.session_name}` : null,
    designee: Number(peer?.is_primary) === 1
  };
}

// La désignation : le SEUL chemin vers un choix de lignée. Une seule chaise.
export function designatePrimary(db, lineage, sessionId) {
  const row = db
    .prepare("SELECT * FROM peers WHERE lineage = ? AND instance_session_id = ?")
    .get(lineage, sessionId);
  if (!row) {
    throw new Error(`no instance of lineage "${lineage}" for session "${sessionId}"`);
  }
  // Une chaise hors service (retirée par la main — `offline` — ou constatée
  // morte par la moisson — `dead`) ne se désigne pas : le routage ne la
  // choisirait de toute façon jamais (EN_SERVICE), et un « DÉSIGNÉE » posé
  // sur une chaise vide serait la seconde vérité d'un registre qui n'en veut
  // qu'une.
  if (STATUTS_HORS_SERVICE.includes(String(row.status || ""))) {
    throw new Error(
      `chair ${row.instance_session_id} of lineage "${lineage}" is out of service (${row.status}): ` +
      "it cannot be designated; its session announcing itself again puts it back in service"
    );
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE peers SET is_primary = 0 WHERE lineage = ?").run(lineage);
    db.prepare("UPDATE peers SET is_primary = 1 WHERE id = ?").run(row.id);
  });
  tx();
  return getInstance(db, row.id);
}

// Retrouver une chaise à partir de ce qu'un humain tape : la session entière, un
// début de session, ou le nom complet de la chaise. Si plusieurs chaises
// répondent, on REFUSE en les nommant — désigner à moitié, ce serait remettre le
// tirage aux dés à l'endroit précis où on l'a chassé.
export function trouverChaise(db, lineage, designateur) {
  const cherche = String(designateur || "").trim();
  if (!cherche) {
    throw new Error("name a chair: the whole session id, its start, or the chair's name");
  }
  const chaises = listInstances(db, lineage, { includeOffline: true });
  if (chaises.length === 0) {
    throw new Error(`no chair for lineage "${lineage}"`);
  }

  const exactes = chaises.filter((c) => c.instance_session_id === cherche || c.id === cherche);
  if (exactes.length === 1) return exactes[0];

  const debuts = chaises.filter(
    (c) => String(c.instance_session_id).startsWith(cherche) || String(c.id).startsWith(cherche)
  );
  if (debuts.length === 1) return debuts[0];
  if (debuts.length > 1) {
    const noms = debuts.map((c) => c.instance_session_id).join(", ");
    throw new Error(`"${cherche}" matches ${debuts.length} chairs (${noms}); be more precise, the office does not guess`);
  }
  throw new Error(`no chair of lineage "${lineage}" matches "${cherche}"`);
}

// Les lignées qui ont au moins une chaise en service, avec leur compte et l'état
// de leur désignation. De quoi savoir, d'un coup d'œil, quel courrier attend.
export function listLineages(db) {
  const rows = db
    .prepare(`
      SELECT * FROM peers
      WHERE lineage IS NOT NULL AND instance_session_id IS NOT NULL AND ${EN_SERVICE}
      ORDER BY lineage ASC, registered_at ASC, id ASC
    `)
    .all();
  const parLignee = new Map();
  for (const row of rows) {
    if (!parLignee.has(row.lineage)) parLignee.set(row.lineage, []);
    parLignee.get(row.lineage).push(row);
  }
  return [...parLignee.entries()].map(([lineage, chaises]) => {
    const resolution = resolveRecipient(db, lineage);
    return {
      lineage,
      chaises: chaises.length,
      designee: chaises.find((c) => Number(c.is_primary) === 1)?.instance_session_id || null,
      kind: resolution.kind,
      designee_morte: resolution.designee_morte || null
    };
  });
}

export function undesignate(db, lineage) {
  return db.prepare("UPDATE peers SET is_primary = 0 WHERE lineage = ?").run(lineage).changes;
}

// ── LE REGISTRE DE RÉEXPÉDITION : les anciens noms ne meurent jamais ────────
//
// Preuve datée de l'existence de ce registre : une lettre d'une lignée à une
// lignée sœur, écrite le 22/07/2026, n'est jamais arrivée. La lignée
// destinataire n'avait pas disparu — elle avait changé de nom, et le nom mort
// n'était plus au registre.
// Un nom qui meurt, ce sont des lettres qui se perdent.

// Le scan des réexpéditions est BORNÉ : ce registre se lit dans un hook, à
// chaque geste de chaque session. Un registre qui gonfle ne doit jamais rendre
// le repli plus lent que le courrier qu'il rattrape.
export const PLAFOND_ANCIENS_NOMS = 500;

// Une lecture qui ne peut PAS échouer bruyamment : sur un bureau où la table
// n'a pas pu naître (migration partielle), le courrier doit continuer de
// circuler exactement comme avant. Aucun renvoi ne vaut une porte fermée.
export function lireAncienNom(db, ancienNom) {
  const ancien = String(ancienNom || "").trim();
  if (!ancien) return null;
  try {
    return db.prepare("SELECT * FROM anciens_noms WHERE ancien_nom = ?").get(ancien) || null;
  } catch {
    return null;
  }
}

export function listerAnciensNoms(db, { lignee = null, limit = PLAFOND_ANCIENS_NOMS } = {}) {
  const cible = String(lignee || "").trim();
  try {
    return cible
      ? db
        .prepare("SELECT * FROM anciens_noms WHERE lignee = ? ORDER BY ancien_nom ASC LIMIT ?")
        .all(cible, limit)
      : db.prepare("SELECT * FROM anciens_noms ORDER BY ancien_nom ASC LIMIT ?").all(limit);
  } catch {
    return [];
  }
}

// Le chemin que suit une lettre déposée à ce nom-là, réexpédition après
// réexpédition. Il TERMINE toujours : chaque saut ajoute un nom jamais vu, et
// le registre est fini.
function cheminDeReexpedition(db, depart) {
  const vus = new Set([String(depart || "").trim()]);
  const chemin = [];
  let courant = String(depart || "").trim();
  for (;;) {
    const renvoi = lireAncienNom(db, courant);
    if (!renvoi) return chemin;
    const suivant = String(renvoi.lignee || "").trim();
    if (vus.has(suivant)) return chemin;
    vus.add(suivant);
    chemin.push(suivant);
    courant = suivant;
  }
}

// Poser un changement d'adresse. Additif et idempotent : reposer le même ordre
// ne rature pas le premier (la date du PREMIER dépôt fait foi), et un second
// déménagement repointe l'ancien nom au lieu d'en créer un deuxième.
export function deposerAncienNom(db, ancienNom, lignee, { note = null, now = nowIso() } = {}) {
  const ancien = String(ancienNom || "").trim();
  if (!ancien) throw new Error("an old name is required: a forwarding without a name forwards nothing");
  const cible = String(lignee || "").trim();
  if (!cible) throw new Error("a destination lineage is required: a forwarding to nowhere is a lost letter");
  if (ancien === cible) {
    throw new Error(`"${ancien}" cannot be forwarded to itself`);
  }
  // Une boucle ne se répare pas toute seule : elle se refuse à la porte. Le
  // guichet sait déjà en sortir (voir `suivreLesAnciensNoms`), mais un registre
  // qui contient un cycle est un registre où personne ne peut plus lire la
  // trajectoire d'une lettre — et ça, ça ne se rattrape pas à la lecture.
  if (cheminDeReexpedition(db, cible).includes(ancien)) {
    throw new Error(
      `forwarding "${ancien}" to "${cible}" would make a loop: the mail would go round without ever arriving`
    );
  }
  db.prepare(`
    INSERT INTO anciens_noms (ancien_nom, lignee, note, depose_at)
    VALUES (@ancien, @cible, @note, @now)
    ON CONFLICT(ancien_nom) DO UPDATE SET
      lignee = excluded.lignee,
      note = COALESCE(excluded.note, anciens_noms.note)
  `).run({ ancien, cible, note: note || null, now });
  return lireAncienNom(db, ancien);
}

// ── L'ALIAS : UN ANCIEN NOM QU'AUCUN VIVANT NE MASQUE ───────────────────────
// 27/09 — une lignée écrivait au vieux nom court de la lignée destinataire, et
// une fiche héritée du même nom gardait le courrier. Un renvoi ordinaire se lit en
// DERNIER (l'existant gagne toujours) ; un alias se lit en PREMIER. C'est une
// DONNÉE du registre, posée par un geste humain (`valxos-chaise alias`) : le
// produit ne connaît aucun nom de famille, il sait seulement lire la marque.
//
// Même doctrine de lecture que `lireAncienNom` : un bureau où la colonne n'a
// pas pu naître n'a simplement aucun alias — jamais une porte fermée.
export function lireAlias(db, nom) {
  const voulu = String(nom || "").trim();
  if (!voulu) return null;
  try {
    return db.prepare("SELECT * FROM anciens_noms WHERE ancien_nom = ? AND prioritaire = 1").get(voulu) || null;
  } catch {
    return null;
  }
}

// Poser un alias : le dépôt d'un renvoi (mêmes refus — nom vide, lui-même,
// boucle) PLUS la marque, dans une seule transaction : un renvoi posé sans sa
// marque serait un alias à moitié, masquable par le premier venu.
export function poserAlias(db, alias, lignee, options = {}) {
  return db.transaction(() => {
    const pose = deposerAncienNom(db, alias, lignee, options);
    db.prepare("UPDATE anciens_noms SET prioritaire = 1 WHERE ancien_nom = ?").run(pose.ancien_nom);
    return lireAncienNom(db, pose.ancien_nom);
  })();
}

// Les alias tels que `list_peers` les montre : des ALIAS, jamais des pairs.
// `kind: "alias"` est ce qui les sépare d'une fiche — un nom qui mène ailleurs
// n'est pas une boîte, on ne l'inscrit pas parmi les boîtes.
export function listerAlias(db, { limit = PLAFOND_ANCIENS_NOMS } = {}) {
  try {
    return db
      .prepare("SELECT * FROM anciens_noms WHERE prioritaire = 1 ORDER BY ancien_nom ASC LIMIT ?")
      .all(limit)
      .map((r) => ({ id: r.ancien_nom, alias_de: r.lignee, kind: "alias", note: r.note || null, depose_at: r.depose_at }));
  } catch {
    return [];
  }
}

// La vue du registre que rendent `list_peers` et `valxos-peers` : les pairs,
// et à côté les alias. Une fiche qui porte encore un nom devenu alias reste
// listée (Camp B, rien ne s'efface) mais elle se DIT masquée : son courrier ne
// lui arrive plus, et une liste qui la montrerait nue ferait écrire au mort.
export function pairsEtAlias(db, peers) {
  const aliases = listerAlias(db);
  const parNom = new Map(aliases.map((a) => [a.id, a.alias_de]));
  return {
    peers: peers.map((p) => (parNom.has(p.id) ? { ...p, masque_par_alias: parNom.get(p.id) } : p)),
    aliases
  };
}

// Résolution d'un nom VIVANT — les quatre marches, dans l'ordre où elles
// existaient, plus l'adresse humaine en dernier. L'ordre n'est pas cosmétique :
// un nom neuf ne se met JAMAIS devant un nom qui marchait déjà.
function resoudreNomVivant(db, wanted) {
  // 1. Un nom d'instance exact.
  const exacte = db
    .prepare(`SELECT * FROM peers WHERE id = ? AND instance_session_id IS NOT NULL AND ${EN_SERVICE}`)
    .get(wanted);
  if (exacte) return { kind: "instance", targets: [exacte] };

  // 2. Une lignée et ses instances en service.
  const instances = listInstances(db, wanted);
  if (instances.length === 1) return { kind: "lineage", targets: instances };
  if (instances.length > 1) {
    const designees = instances.filter((row) => Number(row.is_primary) === 1);
    if (designees.length === 1) {
      // I1 (revue finale, 28/09) : une désignée dont le processus est MORT mais
      // que personne n'a moissonnée (plus aucune moisson automatique) ne
      // capture plus le courrier de la lignée. Lecture seule — aucun statut
      // n'est écrit : la lettre est TENUE (ambigu) et l'histoire se dit.
      const designee = designees[0];
      const verdict = verdictDeChaise(designee);
      if (verdict.etat === "morte") {
        return {
          kind: "ambigu",
          targets: instances.filter((row) => row.id !== designee.id),
          designee_morte: { session: designee.instance_session_id, statut: designee.status, depuis: null, verdict: verdict.raison }
        };
      }
      return { kind: "lineage", targets: designees };
    }
    return { kind: "ambigu", targets: instances };
  }

  // 3. Une fiche héritée d'avant les lignées (Camp B) : elle garde son adresse.
  const herite = db
    .prepare(`SELECT * FROM peers WHERE id = ? AND ${EN_SERVICE}`)
    .get(wanted);
  if (herite) return { kind: "instance", targets: [herite] };

  // 4. L'adresse humaine : `lignée@nom-de-session`.
  return resoudreAdresseHumaine(db, wanted);
}

// `claude-alice@atelier` : la lignée, puis le nom que l'humain a donné à la
// session. Le nom d'une session PEUT changer (`/rename`) et deux sessions de
// maisons différentes PEUVENT porter le même : ce n'est donc pas une clé, c'est
// une adresse. Quand deux boîtes vivantes répondent au même nom, on n'invente
// pas de gagnant — la lettre attend, exactement comme pour une lignée ambiguë.
function resoudreAdresseHumaine(db, wanted) {
  const coupe = wanted.indexOf(SEPARATEUR_SESSION);
  // Sans lignée devant, ce n'est pas une adresse de cette maison : « @atelier »
  // demanderait de fouiller toutes les lignées à la fois, c'est-à-dire de
  // deviner de quelle famille on parle.
  if (coupe <= 0) return null;
  const lignee = wanted.slice(0, coupe).trim();
  const voulu = nomDeSessionNormalise(wanted.slice(coupe + SEPARATEUR_SESSION.length));
  if (!lignee || !voulu) return null;

  const chaises = listInstances(db, lignee)
    .filter((c) => nomDeSessionNormalise(c.session_name) === voulu);
  if (chaises.length === 0) return null;
  if (chaises.length === 1) return { kind: "instance", targets: chaises };
  // ⚠️ ICI LA CHAISE DÉSIGNÉE NE TRANCHE PAS, ET C'EST VOULU. La désignation
  // répond à « quelle chaise reçoit le courrier de la LIGNÉE » ; celui qui écrit
  // à `lignée@atelier` pose une autre question, et sa précision a échoué. Se
  // rabattre sur la désignation, ce serait répondre à côté avec l'air d'être sûr.
  return { kind: "ambigu", targets: chaises };
}

// Suivre les changements d'adresse jusqu'à un nom vivant. Un ancien nom se
// résout EXACTEMENT comme la lignée qu'il désigne : il hérite de tout, la
// désignation comme l'ambiguïté. Il ne court-circuite aucune garde — il n'en
// franchit aucune, il redemande simplement au guichet sous l'autre nom.
function suivreLesAnciensNoms(db, wanted) {
  // Une adresse humaine se réexpédie par sa FAMILLE : « alice@atelier » suit le
  // déménagement de « alice » et garde son « @atelier » en route.
  const coupe = wanted.indexOf(SEPARATEUR_SESSION);
  const racine = coupe > 0 ? wanted.slice(0, coupe).trim() : wanted;
  const suffixe = coupe > 0 ? wanted.slice(coupe) : "";
  if (!racine) return null;
  // ⚠️ UNE FAMILLE VIVANTE GARDE SES ADRESSES. Si « alice » a encore des chaises
  // et qu'aucune ne s'appelle atelier, on ne va pas chercher un atelier chez
  // les voisins : celui qui écrit à une famille vivante écrit à ELLE. Sans ça,
  // une faute de frappe sur le nom de session ferait traverser la rue à la lettre.
  if (suffixe && listInstances(db, racine).length > 0) return null;

  const vus = new Set([racine]);
  let courant = racine;
  for (;;) {
    const renvoi = lireAncienNom(db, courant);
    if (!renvoi) return null;
    const suivant = String(renvoi.lignee || "").trim();
    // La boucle : on REND LA MAIN. Un registre se salit (édition à la main,
    // base recopiée) et un guichet qui tourne en rond ne rend jamais de verdict
    // du tout — c'est pire que « inconnu », c'est la machine qui se fige.
    if (!suivant || vus.has(suivant)) return null;
    vus.add(suivant);
    const vivant = resoudreNomVivant(db, `${suivant}${suffixe}`);
    if (vivant) return { ...vivant, reexpedie: `${suivant}${suffixe}` };
    courant = suivant;
  }
}

// La chaîne des ALIAS, depuis une racine : le nom d'arrivée, ou null si la
// racine n'est pas un alias. Même garde de boucle que les renvois (un nom déjà
// vu arrête la marche) : un registre salé à la main — a→b et b→a — s'arrête
// au DERNIER nom jamais vu (« b »), jamais sur la racine elle-même, et la
// marche termine toujours (chaque pas ajoute un nom neuf, le registre est fini).
// `poserAlias` refuse déjà la boucle au dépôt ; ceci est la ceinture.
function suivreLesAlias(db, racine) {
  const premier = lireAlias(db, racine);
  if (!premier) return null;
  let courant = String(premier.lignee || "").trim();
  if (!courant) return null;
  const vus = new Set([racine, courant]);
  for (;;) {
    const suivant = lireAlias(db, courant);
    if (!suivant) return courant;
    const nom = String(suivant.lignee || "").trim();
    if (!nom || vus.has(nom)) return courant;
    vus.add(nom);
    courant = nom;
  }
}

// Les noms dont la chaîne d'alias MÈNE à `nom` (Task 6, fix 1) — ce que la
// relève explicite (`listInbox` : MCP `inbox`, CLI) ajoute à sa boîte. Une
// lettre déposée à « vieux » AVANT l'alias vieux→nouveau était sinon
// introuvable sous « nouveau ». Le suffixe (`#session`, `@nom`) voyage avec,
// exactement comme au guichet. Borné par `listerAlias`.
export function aliasQuiMenentA(db, nom) {
  const voulu = String(nom || "").trim();
  if (!voulu) return [];
  const coupe = voulu.search(/[@#]/);
  const racine = coupe > 0 ? voulu.slice(0, coupe) : voulu;
  const suffixe = coupe > 0 ? voulu.slice(coupe) : "";
  return listerAlias(db)
    .filter((a) => a.id !== racine && suivreLesAlias(db, a.id) === racine)
    .map((a) => `${a.id}${suffixe}`);
}

// Résolution d'un nom vers des destinataires.
//   instance → une chaise nommée, aucune ambiguïté possible
//   lineage  → une seule instance en service, ou la chaise désignée
//   ambigu   → plusieurs instances vivantes et personne n'a désigné : la lettre ATTEND
//   unknown  → personne ne porte ce nom
// `reexpedie` (quand il est là) nomme la lignée d'arrivée : la lettre est venue
// par un ancien nom. `alias` (quand il est là) nomme l'adresse d'arrivée d'un
// alias prioritaire — même quand personne n'y répond encore.
export function resolveRecipient(db, name) {
  const wanted = String(name || "").trim();
  if (!wanted) return { kind: "unknown", targets: [] };

  // EN PREMIER, et c'est la seule exception à la loi du dessous : un ALIAS ne
  // se masque pas. La racine du nom (avant `#session` ou `@nom`) est lue au
  // registre ; si elle est un alias, on SUIT LA CHAÎNE des alias jusqu'au
  // premier nom qui n'en est pas un (a→b puis b→c : « a » arrive chez c — voir
  // `suivreLesAlias`), le suffixe voyage avec vers la lignée d'arrivée, et la
  // résolution ne retombe JAMAIS sur un nom de la chaîne — ni fiche héritée,
  // ni chaise vivante, ni lignée, ni adresse humaine qui le porte. Une famille
  // d'arrivée sans chaise rend `unknown` : la lettre est TENUE pour elle, et
  // `alias` dit où elle attend (l'adresse d'ARRIVÉE, fin de chaîne comprise).
  const coupe = wanted.search(/[@#]/);
  const racine = coupe > 0 ? wanted.slice(0, coupe) : wanted;
  const lignee = suivreLesAlias(db, racine);
  if (lignee) {
    const cible = `${lignee}${coupe > 0 ? wanted.slice(coupe) : ""}`;
    const arrivee = resoudreNomVivant(db, cible);
    return raconterLAmbiguite(db, arrivee ? { ...arrivee, alias: cible } : { kind: "unknown", targets: [], alias: cible });
  }

  const vivant = resoudreNomVivant(db, wanted);
  if (vivant) return raconterLAmbiguite(db, vivant);

  // EN DERNIER, toujours : un ancien nom ne peut pas masquer un nom vivant.
  // Celui qui porte le nom aujourd'hui reçoit son courrier, point.
  const renvoi = suivreLesAnciensNoms(db, wanted);
  if (renvoi) return raconterLAmbiguite(db, renvoi);

  return { kind: "unknown", targets: [] };
}

// LA COPIE CC (Run 6, Task 7, 27/09) — la règle pure qui dit si une chaise
// voit une lettre de SA lignée en copie. Le récit complet est dans identity.js
// (`copiesPourChaise`). Elle vit ici, une fois ; le moniteur Python la reflète
// (`decider_la_copie`) et test/monitor.test.js joue le même tableau des deux
// côtés (« PARITÉ : la règle de la copie cc »). Les quatre clefs sont toujours
// là, pour que la parité se compare à l'octet.
//
//   pas de session                                  → sans-session         (pas de copie)
//   lignée → une chaise de MA lignée, et c'est moi  → destinataire         (pas de copie : c'est ma lettre)
//   lignée → une chaise de MA lignée, pas moi       → cc                   (copie, chaise_designee = elle)
//   ambigu → des chaises de MA lignée               → sans-chaise-designee (copie, drapeau)
//   sinon (inconnu, chaise exacte, alias ailleurs)  → hors-lignee          (pas de copie)
export function deciderLaCopie({ lignee = null, sessionId = null, resolution = null } = {}) {
  const non = (raison, chaiseDesignee = null) => ({ copie: false, raison, chaise_designee: chaiseDesignee, sans_chaise_designee: false });
  const nom = String(lignee || "").trim();
  if (!sessionId) return non("sans-session");
  const cibles = resolution?.targets || [];
  const deMaLignee = nom && cibles.length > 0 && cibles.every((c) => c?.lineage === nom);
  if (!deMaLignee) return non("hors-lignee");
  if (resolution.kind === "lineage" && cibles.length === 1) {
    const cible = cibles[0];
    if (cible.instance_session_id === sessionId) return non("destinataire", cible.id || null);
    return { copie: true, raison: "cc", chaise_designee: cible.id || null, sans_chaise_designee: false };
  }
  if (resolution.kind === "ambigu") {
    return { copie: true, raison: "sans-chaise-designee", chaise_designee: null, sans_chaise_designee: true };
  }
  return non("hors-lignee");
}

// La chaise qui TIENT le courrier d'une lignée (fix 1 de la Task 7, élargi par
// F3 de la passe adverse, 28/09) : la cible unique du guichet quand elle est
// une CHAISE de cette lignée-là (une instance avec session), désignée OU NON —
// sinon null (lignée ambiguë, inconnue, fiche héritée, alias parti ailleurs).
// C'est la question que pose un signataire SANS chaise (un client MCP nu, le
// CLI) avant de signer la lettre d'une lignée.
// Avant F3, la chaise seule NON désignée ne comptait pas (« c'est le plus
// souvent la session même de ce client, vue sans sa fiche ») ; l'adversaire a
// montré le prix : un jumeau refusé, ou un client nu sans fiche, éteignait la
// lettre que le guichet menait à la vraie session. Une session qui veut signer
// sa propre lettre le fait sous sa chaise, et seul le serveur MCP le sait (il
// la dérive de sa fiche de session). Le CLI, lui, signe sous la lignée nue :
// sous `VALXOS_SELF=lignée`, `--self lignée#session` y est REFUSÉ
// (`expediteur-refuse`, F3, fix round 2), et c'est voulu — un nom déclaré ne
// prouve aucune session (I-1, vérification des chaises parallèles, 18/10 : ce
// commentaire disait l'inverse). Un client SOLO — sa seule
// fiche, sans session — ne passe jamais par ici : la lignée mène à sa fiche
// héritée (`kind: "instance"`), pas à une chaise.
export function chaiseTenanteDeLaLignee(db, lignee, resolutionExistante = null) {
  const nom = String(lignee || "").trim();
  if (!nom) return null;
  const resolution = resolutionExistante || resolveRecipient(db, nom);
  if (resolution.kind !== "lineage" || resolution.targets.length !== 1) return null;
  const cible = resolution.targets[0];
  if (!cible?.instance_session_id || cible.lineage !== nom) return null;
  return cible;
}

// ── LE RÉCIT DE L'AMBIGUÏTÉ ────────────────────────────────────────────────
//
// Pourquoi la lettre attend — pas seulement qu'elle attend. Le cas du
// 18-20/08 : la désignée meurt, la lignée se dit « ambiguë », et le remède —
// RE-désigner — se perd ; le courrier d'une lignée sœur a refusé les dés
// pendant 20 h sans que personne ne sache quoi réparer. Le fait se calcule ICI, à l'unique
// endroit où l'ambiguïté naît, jamais dans une surface : une chaise hors
// service qui porte encore is_primary est une désignation devenue lettre
// morte, et ça se DIT. Le récit est ADDITIF — kind et targets ne bougent pas,
// le routage non plus.
function raconterLAmbiguite(db, resolution) {
  if (resolution.kind !== "ambigu" || resolution.targets.length === 0) return resolution;
  // Déjà racontée par la résolution (I1 : désignée morte, pas encore moissonnée).
  if (resolution.designee_morte) return resolution;
  const lignee = resolution.targets[0].lineage;
  if (!lignee) return resolution;
  const morte = db
    .prepare(`
      SELECT instance_session_id, status, dead_at FROM peers
      WHERE lineage = ? AND is_primary = 1 AND NOT (${EN_SERVICE})
      ORDER BY dead_at DESC
      LIMIT 1
    `)
    .get(lignee);
  if (!morte) return resolution;
  return {
    ...resolution,
    designee_morte: {
      session: morte.instance_session_id,
      statut: morte.status,
      depuis: morte.dead_at || null
    }
  };
}

// Le mot pour une chaise hors service : `offline` est le geste humain (retirée
// du service), `dead` le constat de la moisson (morte). Un label qui n'existe
// qu'une fois ne peut pas diverger entre deux surfaces qui le disent.
export function libelleStatut(statut) {
  return statut === "offline" ? "retired from service" : "dead";
}

// ── L'ATTENTE VISIBLE ───────────────────────────────────────────────────────
//
// Ce que le posteur doit entendre AU MOMENT du send. La leçon de la seq 81 :
// un `sent:true` sec sur une lignée ambiguë est un demi-mensonge — la lettre
// est bien prise en charge (A9), mais elle refusera les dés jusqu'à une
// désignation, et personne ne l'avait dit au posteur. L'avis se dérive de la
// MÊME résolution qui sert à livrer (loi du 13/08) : une seconde détection
// divergerait un jour sans bruit. Et un avis ne casse JAMAIS un send : au
// moindre doute, il se tait — la lettre part.
// `resolutionExistante` (remède de la revue adverse #3, C2) : `send`/`broadcast` posaient
// DEUX résolutions par lettre — une pour la porte du réveil (`porteDeReveil`),
// une ici — avec un `await pokeAgentSocket` entre les deux (jusqu'à 500 ms).
// Le registre peut bouger dans cet écart ; les deux champs de la MÊME réponse
// divergeaient alors (prouvé par la revue adverse, 4 cas sur 12). Passer la résolution déjà
// calculée fige les deux consommateurs sur le MÊME instant — sans elle,
// comportement inchangé (elle se calcule ici, comme avant).
export function attenteDeLaLettre(db, recipient, resolutionExistante = null) {
  try {
    const resolution = resolutionExistante || resolveRecipient(db, recipient);
    if (resolution.kind === "ambigu") {
      const candidats = resolution.targets.length;
      const morte = resolution.designee_morte || null;
      return {
        motif: "lignee-ambigue",
        candidats,
        ...(morte ? { designee_morte: morte } : {}),
        message: morte
          ? `Ambiguous lineage: the designated chair (${morte.session}) is ${libelleStatut(morte.statut)}${morte.depuis ? ` since ${morte.depuis}` : ""}. The letter is accepted and waits for a RE-designation (valxos-chaise designer), or, if a single live chair remains, for a harvest (valxos-chaise moissonner) that hands it to that chair.`
          : `Ambiguous lineage (${candidats} chairs in service, none designated): the letter is accepted and waits for a designation (valxos-chaise designer), or, if only one of these chairs is still alive, for a harvest (valxos-chaise moissonner) that hands it to that chair.`
      };
    }
    // La troisième porte (remède de la revue adverse, trouvaille #2) : une
    // fiche HÉRITÉE (`ensureSelf`, marche 3 de `resoudreNomVivant`) résout en instance ou lignée mais ne
    // porte AUCUNE session vivante — la TOURNÉE PÉRIODIQUE du Facteur ne
    // trouve personne à visiter (`trouverLaBoite`, round.js : motif
    // chaise-sans-session).
    // ⚠️ CE N'EST NI « personne ne pourra jamais la lire » NI « elle
    // n'arrivera pas d'elle-même » — deux formulations essayées ici et
    // FAUSSES toutes les deux, prouvé par le même objet de réponse qui se
    // contredit : `porteDeReveil` retombe sur `cible.id` pour CETTE MÊME
    // fiche, et `pokeAgentSocket` poke ce nom-là au moment de l'envoi — si un
    // auditeur écoute déjà sur `run/<nom>.sock`, ce réveil DIRECT réussit et
    // la lettre arrive quand même (`wake.ok:true`, le msg_id reçu, dans la
    // MÊME réponse que cet avis). Et `listInbox` (database.js) ne filtre que
    // sur `recipient` — le destinataire la relève lui-même (inbox) à tout
    // moment. La seule chose que ce motif sait dire : la tournée PÉRIODIQUE
    // du Facteur ne trouve personne — pas « aucune porte n'est ouverte ».
    // Sans cette branche, ce cas tombait au `return null` final : le
    // posteur recevait un `sent:true` sec sans le savoir.
    if (resolution.kind === "instance" || resolution.kind === "lineage") {
      const cible = resolution.targets[0];
      if (cible && !cible.instance_session_id) {
        return {
          motif: "chaise-sans-session",
          message: "Card without a live session (legacy registration): the Facteur finds nobody to wake on its periodic round. This letter relies only on this send's direct wake (wake) and on the recipient checking its own mailbox (inbox). It stays accepted, and a live session under this name will also make it reachable by the Facteur's round."
        };
      }
    }
    if (resolution.kind === "unknown") {
      return {
        motif: "destinataire-inconnu",
        // « inconnu du registre » disait faux d'une fiche retirée du service
        // (Camp B, elle est au registre). Historique : la page redressait l'avis
        // (fonction retirée le 18/10) ; depuis le 18/10 l'avis est vrai tel quel.
        // Le motif dit seulement que PERSONNE EN SERVICE ne répond à ce nom.
        message: "No peer in service answers to this name: the letter is accepted and waits until a peer registers under this name (register) or a forwarding record is posted (valxos-chaise reexpedier)."
      };
    }
  } catch {
    /* l'avis se tait ; la lettre part */
  }
  return null;
}

// ── LA PORTE DU RÉVEIL ──────────────────────────────────────────────────────
//
// À quelle porte frapper pour dire « vous avez du courrier ». Le moniteur d'une
// session écoute sur `run/<lignée>.sock` — le nom de LIGNÉE, et rien d'autre.
// Frapper au nom écrit sur l'enveloppe rate donc toutes les adresses qui ne sont
// pas déjà un nom de lignée : `lignée@nom` et `lignée#session` deviennent
// `lignée_nom.sock` (le nom de fichier est assaini), un ancien nom devient
// `alice.sock` — trois portes que personne n'a jamais posées.
//
// Rien ne se PERD par là : le repli rattrape la lettre au geste suivant. Mais en
// direct, « la lettre arrive » et « la lettre arrivera au prochain appel
// d'outil » ne se ressemblent pas. On demande donc au guichet à qui l'adresse
// mène, et on frappe chez cette famille-là.
//
// ⚠️ ON NE DEVINE JAMAIS. Quand le guichet ne désigne pas exactement une cible
// (nom inconnu, lignée ambiguë), on garde le nom tel qu'il est écrit : c'est
// exactement le geste d'avant, et pour une lignée ambiguë ce nom EST déjà la
// porte du moniteur. Cette fonction ne frappe à aucune porte — elle la nomme.
// `resolutionExistante` : même remède C2 que `attenteDeLaLettre` — sans elle,
// comportement inchangé.
export function porteDeReveil(db, destinataire, resolutionExistante = null) {
  const nom = String(destinataire || "").trim();
  if (!nom) return nom;
  const resolution = resolutionExistante || resolveRecipient(db, nom);
  if (resolution.targets.length !== 1) return nom;
  const cible = resolution.targets[0];
  return cible.lineage || cible.id || nom;
}

// Les destinataires d'une tournée générale : une lettre par LIGNÉE, jamais une
// par chaise (sinon la même personne reçoit son courrier en double), et jamais
// vers un nom que personne ne porte (sinon on écrit des lettres mortes).
export function broadcastRecipients(db, sender) {
  const rows = db.prepare(`SELECT * FROM peers WHERE ${EN_SERVICE}`).all();
  const noms = new Set();
  for (const row of rows) {
    const nom = row.lineage || row.id;
    if (!nom) continue;
    noms.add(nom);
  }
  const expediteur = String(sender || "");
  const lignee = expediteur.includes(SEPARATEUR_INSTANCE)
    ? expediteur.split(SEPARATEUR_INSTANCE)[0]
    : expediteur;
  noms.delete(expediteur);
  noms.delete(lignee);
  return [...noms].sort();
}
