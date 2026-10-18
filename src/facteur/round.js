// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA TOURNÉE — porter le courrier jusqu'au guichet, sans jamais le perdre.
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  CE QUE CE MODULE PROMET, ET CE QU'IL NE PROMET PAS (amendement A8)
// ─────────────────────────────────────────────────────────────────────────
// LIVRAISON AU MOINS UNE FOIS. On préfère un doublon à une lettre perdue. Le
// Facteur REMET AU GUICHET (`carried_at`) ; il ne « livre » jamais — la
// terminalité appartient à l'accusé du destinataire (`acked_at`), à lui seul.
// Un même courrier peut donc apparaître deux fois : c'est un choix, pas un
// défaut. Une lettre vue deux fois est un désagrément ; une lettre perdue est
// une trahison.
//
// ⚠️ UN DOUBLON, PAS UNE AVALANCHE. « Au moins une fois » n'autorise pas mille
// rappels dans l'heure : un compagnon noyé ne peut plus travailler, et A9
// devient la nuisance au lieu du filet. Trois freins tiennent ce bord :
// l'ajournement qui CROÎT à chaque tentative infructueuse (borné, jamais
// infini), le PLAFOND par boîte et par fenêtre (silence borné, jamais
// définitif), et la pause qui suit CHAQUE tentative de dépôt — pas seulement
// celles qui réussissent.
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  L'INVARIANT QUI PRIME SUR TOUT (A9) : accusé nul ⇒ la lettre revient
// ─────────────────────────────────────────────────────────────────────────
// Aucun chemin de ce fichier ne rend une lettre durablement invisible. Il
// n'existe ni état MORTE, ni quarantaine infinie, ni suppression. Ce que le
// Facteur écrit, c'est une ÉCHÉANCE finie (`facteur_not_before_ms`) — et le
// canal de repli (les hooks), lui, ne la regarde même pas : il rattrape ce que
// le Facteur n'a pas su porter.
//
// L'état du courrier NE S'ÉCRIT PAS, il SE DÉRIVE (voir `etatDuCourrier`) :
// `carried_at`, `delivered_at` et `injected_at` sont des OBSERVATIONS
// historiques, jamais des états terminaux. Un porteur qui meurt entre sa marque
// et son geste ne peut donc pas enterrer une lettre.
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  LA FAUTE QUE CE DESSIN REND FACILE — ne la commettez pas
// ─────────────────────────────────────────────────────────────────────────
// Confondre la TENTATIVE et la LETTRE. Il serait tentant de poser le bail
// directement sur `messages` et de clôturer par `msg_id` : un vieux Facteur
// réveillé après l'expiration de SON bail effacerait alors le travail de son
// successeur. Toute clôture (T4, T5) exige donc `attempt_id` + l'état + la
// possession du bail. Zéro ligne modifiée = le porteur est périmé, et il n'a
// plus AUCUN droit sur cette lettre.
import crypto from "node:crypto";
import os from "node:os";

import {
  maisonsConnues,
  reglagesDuFacteur,
  verifierLesReglages
} from "../lib/config.js";
import { journaliserAlias, recordEvent } from "../lib/database.js";
import {
  adresseDeRecu,
  buildEnvelope,
  buildWrapper,
  remettreAuGuichet as remettreAuGuichetReel
} from "../lib/courier.js";
import { isKnownHouse, tourHouses as tourHousesReelle } from "../lib/postbox.js";
import { attenteDeLaLettre, resolveRecipient as resolveRecipientReel } from "../lib/registry.js";

// L'état DÉRIVÉ d'une lettre. Quatre valeurs, aucune stockée.
export const ETAT_ACCUSEE = "ACCUSÉE";
export const ETAT_RESERVEE = "RÉSERVÉE";
export const ETAT_DIFFEREE = "DIFFÉRÉE";
export const ETAT_PRETE = "PRÊTE";

// Les états d'une tentative qui tient encore la lettre.
const TENTATIVES_ACTIVES = "('reservee', 'liee')";

// Le nom de la boîte du Facteur. Son RÉPERTOIRE se dérive toujours de celui du
// destinataire (A5) : jamais /tmp/cc-socks en dur.
export const NOM_DE_LA_BOITE_DU_FACTEUR = "cc2cc-facteur.sock";

export function identiteDuPorteur() {
  return `facteur@${os.hostname().split(".")[0]}#${process.pid}`;
}

function sommeil(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── L'ÉTAT SE DÉRIVE ────────────────────────────────────────────────────────
export function etatDuCourrier(db, msgId, { maintenant = Date.now() } = {}) {
  const lettre = db
    .prepare("SELECT msg_id, acked_at, facteur_not_before_ms FROM messages WHERE msg_id = ?")
    .get(msgId);
  if (!lettre) return null;
  // L'accusé du destinataire : le SEUL état terminal.
  if (lettre.acked_at) return ETAT_ACCUSEE;
  const active = db
    .prepare(`
      SELECT attempt_id FROM facteur_attempts
      WHERE msg_id = ? AND state IN ${TENTATIVES_ACTIVES} AND lease_until_ms > ?
    `)
    .get(msgId, maintenant);
  if (active) return ETAT_RESERVEE;
  return Number(lettre.facteur_not_before_ms || 0) > maintenant ? ETAT_DIFFEREE : ETAT_PRETE;
}

// ── L'AJOURNEMENT QUI CROÎT ─────────────────────────────────────────────────
// A9 dit « la lettre finit toujours par revenir ». Il ne dit pas « toutes les
// dix minutes, pour toujours » : mille rappels en une heure, et le compagnon
// qui les reçoit ne peut plus travailler — le filet devient la nuisance.
// Chaque tentative infructueuse DOUBLE donc l'attente : minutes, puis heures.
//
// ⚠️ LA BORNE EST UN PLAFOND, JAMAIS L'INFINI. `ajournementMaximalMs` est un
// nombre fini : passé lui, l'attente cesse de grandir et la lettre continue de
// revenir. Une croissance sans borne serait une quarantaine déguisée — la seule
// chose que ce fichier n'a pas le droit d'écrire.
export function ajournementCroissant(base, infructueuses, plafond) {
  const socle = Math.max(1, Number(base) || 0);
  const maximum = Math.max(1, Number(plafond) || 0);
  // 24 doublements suffisent à dépasser n'importe quel plafond plausible ; au
  // delà, 2^n cesse d'être un nombre et devient un piège de virgule flottante.
  const doublements = Math.min(Math.max(0, Number(infructueuses) || 0), 24);
  const calcule = socle * 2 ** doublements;
  return Math.min(Number.isFinite(calcule) ? calcule : maximum, maximum);
}

// Combien de fois cette lettre a déjà été portée SANS qu'un accusé n'arrive. On
// compte des TENTATIVES CLOSES — jamais un compteur écrit sur la lettre : l'état
// se dérive, et un compteur ment dès qu'un porteur meurt entre son incrément et
// son geste. Une lettre accusée ne repasse jamais ici : toute tentative close
// sur une lettre encore en vie est, par définition, restée infructueuse.
export function tentativesInfructueuses(db, msgId, attemptIdCourant = null) {
  const ligne = db
    .prepare(`
      SELECT count(*) AS n FROM facteur_attempts
      WHERE msg_id = ? AND state IN ('remise', 'echouee', 'expiree') AND attempt_id <> ?
    `)
    .get(msgId, String(attemptIdCourant || ""));
  return Number(ligne?.n || 0);
}

// ── LE PLAFOND DE POLITESSE ─────────────────────────────────────────────────
// Combien de remises cette boîte a reçues dans la fenêtre qui court. Rien n'est
// compté en mémoire : les tentatives closes portent la mesure, donc un démon
// redémarré ne recommence pas à zéro et ne noie pas la chaise qu'il retrouve.
export function boiteSaturee(db, { sessionId, maintenant, reglages }) {
  const fenetre = Number(reglages.fenetreDuPlafondMs);
  const ligne = db
    .prepare(`
      SELECT count(*) AS remises, MIN(finished_at_ms) AS plusVieille
      FROM facteur_attempts
      WHERE target_session_id = ? AND state = 'remise' AND finished_at_ms > ?
    `)
    .get(String(sessionId), maintenant - fenetre);
  const remises = Number(ligne?.remises || 0);
  if (remises < Number(reglages.plafondParBoite)) return null;
  // La fin de la fenêtre : l'instant où la PLUS VIEILLE des remises comptées en
  // sort. Le silence est donc borné par construction, et il se lève tout seul.
  return { remises, jusqua: Number(ligne.plusVieille) + fenetre };
}

// SE TAIRE pour une boîte, c'est ajourner d'un seul geste tout ce qui lui est
// dû — et écrire le NOMBRE. Porter ces lettres une à une, c'est précisément
// l'avalanche qu'on refuse. Aucune n'est marquée, aucune n'est perdue : elles
// restent DUES, et l'échéance est celle de la fenêtre, donc finie.
export function taireLaBoite(db, { destinataire, jusqua }) {
  return db
    .prepare(`
      UPDATE messages
      SET facteur_not_before_ms = ?
      WHERE recipient = ? AND acked_at IS NULL AND facteur_not_before_ms < ?
    `)
    .run(Number(jusqua), String(destinataire), Number(jusqua)).changes;
}

export function lettresDues(db, destinataire) {
  const ligne = db
    .prepare("SELECT count(*) AS n FROM messages WHERE recipient = ? AND acked_at IS NULL")
    .get(String(destinataire));
  return Number(ligne?.n || 0);
}

// ── T6 — l'expiration des baux ──────────────────────────────────────────────
// L'écoulement du temps rend une tentative REPRENABLE ; c'est le prochain
// réservant qui la matérialise. Un Facteur mort ne bloque donc rien plus
// longtemps que son bail.
export function perimerLesBaux(db, maintenant) {
  return db
    .prepare(`
      UPDATE facteur_attempts
      SET state = 'expiree', finished_at_ms = ?, reason = 'bail-expire'
      WHERE state IN ${TENTATIVES_ACTIVES} AND lease_until_ms <= ?
    `)
    .run(maintenant, maintenant).changes;
}

// ── T1 — RÉSERVER ───────────────────────────────────────────────────────────
// Transaction TRÈS COURTE, et AUCUN accès socket dedans. Si le bureau est
// fermé (verrouillé, en lecture seule, disque plein), elle lève : pas de
// réservation durable, donc pas de remise. C'est la garde qui interdit de
// porter une lettre qu'on ne saura pas marquer.
//
// La sélection est bornée par un BALAYAGE à frontière figée : c'est la garantie
// contre la famine (voir `docs/FACTEUR.md`). Une lettre bloquée passe derrière
// le curseur au lieu de remplir toutes les tournées.
export function prendreUneLettre(db, { porteur, maintenant, reglages, seulementLaLettre = null }) {
  const bail = Number(reglages.bailMs);
  // ⚠️ LE MODE UNE-LETTRE. `@seulement` non nul RESTREINT ; il n'ÉLARGIT jamais.
  // Un identifiant qui ne correspond à rien rend zéro ligne — jamais toute la
  // file : un Facteur lancé à côté de vraies boîtes porterait sinon du courrier
  // réel que personne n'a demandé.
  const seulement = seulementLaLettre === null || seulementLaLettre === undefined ? null : String(seulementLaLettre);
  const choisir = db.prepare(`
    SELECT m.*
    FROM messages m
    LEFT JOIN facteur_attempts a
      ON a.msg_id = m.msg_id
     AND a.state IN ${TENTATIVES_ACTIVES}
     AND a.lease_until_ms > @maintenant
    JOIN facteur_sweep s ON s.singleton = 1
    WHERE m.acked_at IS NULL
      AND m.facteur_not_before_ms <= @maintenant
      AND m.seq > s.cursor_seq
      AND m.seq <= s.sweep_max_seq
      AND a.attempt_id IS NULL
      AND (@seulement IS NULL OR m.msg_id = @seulement)
    ORDER BY m.seq ASC
    LIMIT 1
  `);
  // Un balayage épuisé se rouvre : la frontière est refigée sur le courrier
  // d'aujourd'hui. Sans cette réouverture, une lettre neuve (seq > frontière)
  // resterait derrière un préfixe de lettres ajournées jusqu'à leur échéance —
  // une famine par ajournement.
  const rouvrirLeBalayage = db.prepare(`
    UPDATE facteur_sweep
    SET cursor_seq = 0,
        sweep_max_seq = (SELECT COALESCE(MAX(seq), 0) FROM messages)
    WHERE singleton = 1 AND cursor_seq >= sweep_max_seq
  `);
  const cloreLeBalayage = db.prepare(
    "UPDATE facteur_sweep SET cursor_seq = sweep_max_seq WHERE singleton = 1"
  );

  const prise = db.transaction(() => {
    perimerLesBaux(db, maintenant);
    rouvrirLeBalayage.run();
    let lettre = choisir.get({ maintenant, seulement });
    if (!lettre) {
      // Rien dans la fenêtre courante : on la referme et on en ouvre une neuve,
      // UNE seule fois (la transaction doit rester courte).
      cloreLeBalayage.run();
      rouvrirLeBalayage.run();
      lettre = choisir.get({ maintenant, seulement });
    }
    if (!lettre) return null;

    const attemptId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO facteur_attempts (attempt_id, msg_id, owner_id, state, claimed_at_ms, lease_until_ms)
      VALUES (?, ?, ?, 'reservee', ?, ?)
    `).run(attemptId, lettre.msg_id, porteur, maintenant, maintenant + bail);
    db.prepare("UPDATE facteur_sweep SET cursor_seq = ? WHERE singleton = 1").run(lettre.seq);
    // Jamais le corps, jamais l'objet, jamais le jeton.
    recordEvent(db, lettre.msg_id, porteur, "facteur_reservee", { attempt_id: attemptId });
    return { attemptId, lettre };
  });

  return prise.immediate();
}

// ── T2 — LIER LA CIBLE ──────────────────────────────────────────────────────
// La cible est un QUADRUPLET durable : (maison, session, heure de démarrage,
// chemin de la boîte). L'écrire, c'est pouvoir dire plus tard QUELLE
// incarnation était visée — et refuser l'accusé de n'importe quelle autre.
export function lierLaBoite(db, { attemptId, boite, maintenant, reglages }) {
  const changes = db
    .prepare(`
      UPDATE facteur_attempts
      SET state = 'liee',
          target_house = ?,
          target_session_id = ?,
          target_proc_start = ?,
          target_socket_path = ?,
          lease_until_ms = ?
      WHERE attempt_id = ?
        AND state = 'reservee'
        AND lease_until_ms > ?
    `)
    .run(
      boite.house,
      boite.sessionId,
      boite.procStart || null,
      boite.socketPath,
      maintenant + Number(reglages.bailMs),
      attemptId,
      maintenant
    ).changes;
  return changes === 1;
}

// ── T4 — ENREGISTRER LA REMISE ──────────────────────────────────────────────
// ⚠️ La clôture exige `attempt_id` + `state = 'liee'` + le bail encore tenu.
// Zéro ligne modifiée ⇒ ce porteur est PÉRIMÉ : un autre a repris la lettre, et
// celui-ci n'a plus le droit d'écrire un mot sur son état.
//
// ⚠️ `carried_at` garde la PREMIÈRE remise (COALESCE), et ce n'est pas un
// détail de style : la fenêtre de grâce du canal de repli se compte DEPUIS
// cette date. Écraser la date à chaque repassage, c'est repousser la grâce à
// chaque repassage — le repli cesserait alors de servir la lettre dès qu'on
// règle le Facteur pour repasser plus vite que la grâce, et A9 mourrait en
// silence, sans qu'aucun défaut ne soit visible aux valeurs par défaut.
//
// Le repassage, lui, S'ÉLOIGNE : deuxième remise sans accusé, on attend deux
// fois plus longtemps ; troisième, quatre fois — jusqu'au plafond, jamais
// au-delà.
export function noterLaRemise(db, { attemptId, msgId, cibleSession, porteur, maintenant, reglages }) {
  const marque = db.transaction(() => {
    const changes = db
      .prepare(`
        UPDATE facteur_attempts
        SET state = 'remise', finished_at_ms = ?
        WHERE attempt_id = ? AND state = 'liee' AND lease_until_ms > ?
      `)
      .run(maintenant, attemptId, maintenant).changes;
    if (changes !== 1) return false;

    const ajournement = ajournementCroissant(
      reglages.ajournementApresRemiseMs,
      tentativesInfructueuses(db, msgId, attemptId),
      reglages.ajournementMaximalMs
    );
    db.prepare(`
      UPDATE messages
      SET carried_at = COALESCE(carried_at, ?),
          facteur_not_before_ms = ?
      WHERE msg_id = ?
    `).run(new Date(maintenant).toISOString(), maintenant + ajournement, msgId);
    recordEvent(db, msgId, porteur, "facteur_remis", {
      attempt_id: attemptId,
      target_session_id: cibleSession,
      reprise_apres_ms: ajournement
    });
    return true;
  });
  return marque.immediate();
}

// ── T5 — ENREGISTRER UN ÉCHEC ───────────────────────────────────────────────
// L'échec n'est JAMAIS terminal : il pose une échéance FINIE. Même « définitif »
// (pli trop gros, enveloppe irrecevable) : on ajourne longtemps, on l'écrit
// visiblement, et la lettre redevient sélectionnable. Un état sans retour
// violerait A9.
//
// L'échéance CROÎT avec les tentatives infructueuses (`croissant`), sauf quand
// l'appelant sait déjà l'heure exacte à laquelle il veut revenir — c'est le cas
// du plafond de politesse, dont l'échéance est la fin de la fenêtre et rien
// d'autre : ce n'est pas la lettre qui a échoué, c'est le Facteur qui se tait.
//
// Rend l'ajournement RÉELLEMENT posé (en millisecondes), ou `null` quand ce
// porteur est périmé et n'a plus le droit d'écrire un mot sur cette lettre.
export function noterLEchec(db, {
  attemptId,
  msgId,
  motif,
  permanent = false,
  ajournementMs,
  plafondMs = null,
  croissant = true,
  porteur,
  maintenant
}) {
  const note = db.transaction(() => {
    const changes = db
      .prepare(`
        UPDATE facteur_attempts
        SET state = 'echouee', finished_at_ms = ?, reason = ?
        WHERE attempt_id = ? AND state IN ${TENTATIVES_ACTIVES} AND lease_until_ms > ?
      `)
      .run(maintenant, String(motif), attemptId, maintenant).changes;
    if (changes !== 1) return null;

    const ajournement = croissant
      ? ajournementCroissant(
          ajournementMs,
          tentativesInfructueuses(db, msgId, attemptId),
          plafondMs === null ? ajournementMs : plafondMs
        )
      : Math.max(1, Number(ajournementMs));
    db.prepare("UPDATE messages SET facteur_not_before_ms = ? WHERE msg_id = ?").run(
      maintenant + ajournement,
      msgId
    );
    // LE MOTIF A-T-IL DE LA MÉMOIRE ? Quand la MÊME cause échoue la lettre
    // tentative après tentative, ré-écrire la même ligne toutes les quatre
    // heures ne dit rien de neuf. La ligne répétée porte donc SA SÉRIE : combien
    // de fois d'affilée, et depuis quand. La « file visible d'intervention » de
    // la dette n°5 (`docs/FACTEUR.md`) devient DÉRIVABLE à la lecture — un seul
    // événement suffit à dire « ce motif tient depuis N tentatives, depuis telle
    // heure », sans relire tout le journal derrière.
    //
    // ⚠️ CE GESTE NE COMPACTE RIEN. Le nombre de lignes ne bouge pas : un échec,
    // une ligne dans `delivery_events`, exactement comme avant — la ligne
    // répétée est même un peu plus grosse, de deux champs. La dette n°5 a deux
    // moitiés ; celle-ci n'en règle qu'UNE. `delivery_events` continue de
    // grossir au même rythme, et rien ici ne pose de borne. Ne lisez pas cette
    // section comme un remède à la croissance : ce n'en est pas un.
    //
    // La ligne `facteur_attempts` s'écrit TOUJOURS, juste au-dessus et quel que
    // soit le motif : c'est elle qui porte le compte dérivé
    // (`tentativesInfructueuses`, `lettresEnSouffrance`). Rien ici ne retranche
    // une observation — le seul changement est le NOM de l'événement et deux
    // champs de plus.
    //
    // Une REMISE entre deux échecs rompt la série : le Facteur a su porter
    // entre les deux, la situation a changé, elle mérite son plein format. Un
    // motif qui change la rompt aussi, pour la même raison. Une EXPIRATION DE
    // BAIL également : un porteur mort au milieu est une interruption, pas une
    // continuité — la série s'arrête là et le plein format se re-dit. C'est le
    // sens strict de « ininterrompue », et ça vaut mieux qu'un compte qui
    // enjamberait un trou qu'aucun Facteur n'a vu.
    //
    // ⚠️ ON MARCHE PAR `rowid`, JAMAIS PAR `finished_at_ms`. Une tournée lit
    // l'horloge DEUX fois — une pour la prise, une pour l'échec — et
    // `docs/FACTEUR.md` (point 6) admet les sauts d'horloge : reculer entre les
    // deux clôt la tentative COURANTE avec une estampille plus vieille que la
    // précédente, et un classement par estampille désignerait alors le mauvais
    // bout de la série. Les tentatives d'UNE lettre sont strictement
    // séquentielles, et ce n'est PAS le SELECT de `prendreUneLettre` qui le
    // tient : deux Facteurs peuvent lire « aucune tentative active » au même
    // instant. Ce qui les départage est l'index UNIQUE PARTIEL
    // `uq_facteur_one_active_attempt` (migrations.js : une seule tentative
    // `reservee`/`liee` par lettre) — dans SQLite, pas dans du JavaScript
    // optimiste. La garde en SELECT et `perimerLesBaux` en tête de transaction
    // évitent le travail inutile et rendent le bail périmé reprenable ; l'index
    // est le seul à tenir l'invariant. Et rien n'efface jamais de
    // `facteur_attempts` (Camp B). L'ordre des `rowid` EST donc
    // l'ordre réel, quoi que raconte l'horloge. Les estampilles restent lues :
    // `depuis` rend celle du plus vieux membre, telle qu'elle a été écrite.
    const closes = db
      .prepare(`
        SELECT state, reason, finished_at_ms FROM facteur_attempts
        WHERE msg_id = ? AND state IN ('remise', 'echouee', 'expiree')
        ORDER BY rowid DESC
      `)
      .all(msgId);
    // La tentative COURANTE vient d'être close par l'UPDATE en tête de cette
    // transaction : elle est déjà là, en tête — la série l'inclut donc
    // naturellement, et une série de UN est un premier échec (plein format).
    //
    // ⚠️ LE TEST D'ÉTAT PORTE, IL N'ACCOMPAGNE PAS (revue adverse F3, 21/08 — collision
    // EXÉCUTÉE). Pour la REMISE, il reste une ceinture de confort : une remise
    // ne porte jamais de motif (`reason` nul), la comparaison rompt déjà seule.
    // Pour l'EXPIRATION, non : `bail-expire` n'est pas un mot réservé, rien
    // n'interdit à un échec de livraison de porter ce motif-là, et ce jour-là
    // les deux lignes disent la même chose — la comparaison ne rompt plus rien
    // et un porteur MORT se compterait comme une répétition. Mesuré :
    // `facteur_echec_repete` au lieu de `facteur_echec`. C'est cette ligne, et
    // elle seule, qui tient le cas. Ne la retirez pas en la prenant pour une
    // redondance.
    let repetitions = 0;
    let depuisMs = null;
    for (const tentative of closes) {
      if (tentative.state === "remise" || tentative.state === "expiree") break;
      if (tentative.reason !== String(motif)) break;
      repetitions += 1;
      depuisMs = Number(tentative.finished_at_ms);
    }
    const repete = repetitions >= 2;
    recordEvent(db, msgId, porteur, repete ? "facteur_echec_repete" : "facteur_echec", {
      attempt_id: attemptId,
      motif: String(motif),
      permanent: Boolean(permanent),
      reprise_apres_ms: ajournement,
      ...(repete ? { repetitions, depuis: new Date(depuisMs).toISOString() } : {})
    });
    return ajournement;
  });
  return note.immediate();
}

// ── LE PLI ──────────────────────────────────────────────────────────────────
// Le reçu voyage DANS le texte : le destinataire a besoin de (lettre, reçu)
// pour accuser la bonne tentative. Il ne devient pas un attribut du pli — leur
// ordre est strict et le destinataire compare l'en-tête à l'octet près.
export function plierLaLettre(lettre, { attemptId = null } = {}) {
  const entete = [`Letter ${lettre.msg_id}`, `from ${lettre.sender}`];
  if (lettre.subject) entete.push(`subject: ${lettre.subject}`);
  const lignes = [entete.join(" · ")];
  if (attemptId) lignes.push(`Receipt: ${attemptId}`);
  lignes.push("", String(lettre.body ?? ""), "");
  lignes.push(
    `— Acknowledge letter ${lettre.msg_id} with the \`ack\` tool; until it is acknowledged the Facteur will bring it back.`
  );
  return lignes.join("\n");
}

// La session de l'expéditeur, quand on la connaît. On ne l'INVENTE pas : une
// lignée ambiguë ou inconnue rend une chaîne vide, jamais un tirage au sort.
function sessionDeLExpediteur(db, sender, resoudre) {
  try {
    const resolution = resoudre(db, sender);
    if (resolution.kind === "instance" || resolution.kind === "lineage") {
      return resolution.targets[0]?.instance_session_id || "";
    }
  } catch {
    /* l'adresse de l'expéditeur n'est pas une condition du portage */
  }
  return "";
}

// ── L'ACHEMINEMENT ──────────────────────────────────────────────────────────
// « Ta maison m'est inconnue » et « ta boîte dort » sont DEUX situations : les
// confondre, c'est mentir à qui attend son courrier (amendement A4).
export function trouverLaBoite(db, lettre, { parSession, houses, resoudre }) {
  const resolution = resoudre(db, lettre.recipient);
  // L'alias voyage avec CHAQUE verdict, livrable ou non : c'est ce qui permet
  // à la tournée de le journaliser, et à un avis de dire où la lettre attend.
  const avec = (verdict) => (resolution.alias ? { ...verdict, alias: resolution.alias } : verdict);
  if (resolution.kind === "unknown") {
    return avec({ motif: "destinataire-inconnu" });
  }
  if (resolution.kind === "ambigu") {
    // La lettre ATTEND. Trancher soi-même, c'est un tirage au sort déguisé, et
    // le prix du tirage c'est une lettre lue par la mauvaise personne.
    return avec({ motif: "lignee-ambigue", candidats: resolution.targets.length });
  }
  const cible = resolution.targets[0];
  const session = cible?.instance_session_id || null;
  if (!session) return avec({ motif: "chaise-sans-session" });

  const boite = parSession.get(session);
  if (boite) return avec({ boite, cible, session });

  const maison = cible.house || null;
  if (!maison) return avec({ motif: "maison-non-renseignee", session });
  if (!isKnownHouse(houses, maison)) return avec({ motif: "maison-inconnue", maison, session });
  return avec({ motif: "boite-endormie", maison, session });
}

// Une session n'a qu'UNE boîte : la carte `sessionId → boîte`, construite
// une fois pour toutes à partir de l'inventaire d'UNE tournée. Extrait de la
// tournée elle-même (remède de la revue adverse #3, C1) pour que `avisDAttente` puisse
// rejouer EXACTEMENT le même geste sans le réécrire une deuxième fois à côté
// — deux copies divergeraient un jour sans bruit, la leçon du jour.
export function construireParSession(boxes) {
  const parSession = new Map();
  for (const boite of boxes) {
    if (boite?.sessionId && !parSession.has(boite.sessionId)) parSession.set(boite.sessionId, boite);
  }
  return parSession;
}

// La tournée des maisons, prête à servir `trouverLaBoite` — MÊME defaults
// que la tournée réelle (`tourHousesReelle`, `maisonsConnues`), pour qu'un
// appelant hors du démon (le guichet MCP, le CLI) obtienne EXACTEMENT ce
// que la prochaine tournée du Facteur verrait, pas une approximation.
export function scannerLesMaisons(deps = {}) {
  const tournerLesMaisons = deps.tourHouses || tourHousesReelle;
  const { boxes, houses } = tournerLesMaisons(deps.maisons || maisonsConnues({ env: deps.env || process.env }));
  return { houses, parSession: construireParSession(boxes) };
}

// ── L'AVIS COMPLET ──────────────────────────────────────────────────────────
// `attenteDeLaLettre` (registry.js) ne voit que TROIS motifs — ambigu,
// inconnu, chaise-sans-session — parce que ce sont les seuls que le REGISTRE
// seul sait trancher, sans scanner les maisons. Mais `trouverLaBoite` en rend
// TROIS DE PLUS (maison-non-renseignee, maison-inconnue, boite-endormie), et
// jusqu'à ce remède (revue adverse #3, C1) `send`/`broadcast` ne les voyaient jamais :
// `sent:true` sec, puis la tournée réelle différait la même lettre avec un
// motif que personne n'avait annoncé — la loi du 20/08 prise en défaut par
// TROIS portes de plus, toutes fermées d'un coup plutôt qu'une par une.
//
// Cette fonction ne RÉIMPLÉMENTE rien : elle rejoue `attenteDeLaLettre` pour
// les trois premiers motifs, PUIS `trouverLaBoite` lui-même — la MÊME
// fonction que la tournée utilise pour acheminer — pour les trois derniers.
// Jamais une deuxième résolution qui pourrait diverger (C2) : si
// `resolutionExistante` est fournie, elle gèle `resoudre` dessus au lieu de
// laisser `trouverLaBoite` interroger le registre une nouvelle fois.
const MESSAGES_MAISON = {
  "maison-non-renseignee": (i) =>
    `Session ${i.session} has no house recorded in the registry: the Facteur does not know where to ring.`,
  "maison-inconnue": (i) =>
    `Session ${i.session} lives in a house (${i.maison}) that the Facteur's round no longer knows: it will not ring there.`,
  // I-4 (vérification des chaises parallèles, 18/10) : l'avis disait
  // « session vivante » d'une chaise dont le processus était parti. Le registre
  // dit seulement que la chaise est en service ; la boîte muette dit le reste.
  "boite-endormie": (i) =>
    `Session ${i.session} is in a known house (${i.maison}), but no mailbox answers there right now: the session process is gone or asleep.`
};

export function avisDAttente(db, lettre, { parSession, houses, resoudre, resolutionExistante = null } = {}) {
  const avisRegistre = attenteDeLaLettre(db, lettre.recipient, resolutionExistante);
  if (avisRegistre) return avisRegistre;
  try {
    const resoudreGele = resolutionExistante ? () => resolutionExistante : resoudre;
    const acheminement = trouverLaBoite(db, lettre, { parSession, houses, resoudre: resoudreGele });
    if (acheminement.boite) return null; // livrable : le silence des cas sains
    const auMessage = MESSAGES_MAISON[acheminement.motif];
    if (!auMessage) return null; // ambigu/inconnu/chaise-sans-session : déjà rendus plus haut
    return {
      motif: acheminement.motif,
      message: `${auMessage(acheminement)} The letter stays accepted: the recipient can check its own mailbox (inbox) at any time.`
    };
  } catch {
    return null; // l'avis se tait ; la lettre part — même doctrine qu'attenteDeLaLettre
  }
}

// ── LA TOURNÉE ──────────────────────────────────────────────────────────────
// LE prédicat « cette tournée a-t-elle bougé » — une seule définition, partagée
// par la porte du journal (ici), le compte des silences du démon (daemon.js) et
// le one-shot (bin/facteur.js). Deux copies divergeraient un jour sans bruit.
export function tourneeBougee(bilan) {
  return (
    bilan.prises > 0 || bilan.remises > 0 || bilan.ajournees > 0 || Object.keys(bilan.motifs || {}).length > 0
  );
}

// SANS CHAISE DÉSIGNÉE (Run 6, Task 7, 27/09) : la lettre de la lignée est tenue
// — livrée à personne comme sienne, chaque chaise vivante n'en voit qu'une copie
// cc — jusqu'à ce qu'un humain désigne. L'ajournement se compte à chaque
// tournée ; le CONSTAT, lui, se dit UNE fois par lettre. La garde est la base
// (un événement `sans_chaise_designee` sur la lettre), jamais un drapeau en
// mémoire : un démon relancé ne le redit pas. Ne lève jamais.
function direSansChaiseDesigneeUneFois(db, lettre, acheminement, porteur, journal) {
  try {
    const dejaDit = db
      .prepare("SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = 'sans_chaise_designee' LIMIT 1")
      .get(lettre.msg_id);
    if (dejaDit) return;
    const detail = { lignee: lettre.recipient, candidats: acheminement.candidats || null };
    recordEvent(db, lettre.msg_id, porteur, "sans_chaise_designee", detail);
    journal({ evenement: "facteur_sans_chaise_designee", msg_id: lettre.msg_id, ...detail });
  } catch {
    /* un constat qui n'a pas pu s'écrire ne change rien au portage */
  }
}

export async function faireLaTournee(db, deps = {}) {
  const reglages = verifierLesReglages({
    ...reglagesDuFacteur(deps.env || process.env),
    ...(deps.reglages || {})
  });
  const horloge = deps.horloge || (() => Date.now());
  const journal = deps.journal || (() => {});
  const porteur = deps.porteur || identiteDuPorteur();
  const tournerLesMaisons = deps.tourHouses || tourHousesReelle;
  const remettre = deps.remettreAuGuichet || remettreAuGuichetReel;
  const resoudre = deps.resolveRecipient || resolveRecipientReel;
  const dormir = deps.dormir || sommeil;
  // ── LE MODE UNE-LETTRE ────────────────────────────────────────────────────
  // La tournée ne prend QUE celle-ci, quoi qu'il y ait d'autre au bureau. C'est
  // la porte de la cérémonie : un Facteur non filtré, lancé à côté de vraies
  // boîtes, porterait du courrier réel que personne n'a prévu.
  const seulementLaLettre = deps.seulementLaLettre || null;

  const bilan = { prises: 0, remises: 0, ajournees: 0, motifs: {} };
  const noter = (motif) => {
    bilan.motifs[motif] = (bilan.motifs[motif] || 0) + 1;
  };

  // A4 — l'inventaire des maisons se RELIT à chaque tournée : une maison créée
  // après le démarrage du démon doit être vue.
  const { boxes, houses } = tournerLesMaisons(deps.maisons || maisonsConnues({ env: deps.env || process.env }));
  // Les boîtes qu'on a déjà fait taire pendant CETTE tournée : on ne recompte
  // pas leur fenêtre à chaque lettre, et surtout on ne journalise leur silence
  // qu'une seule fois.
  const boitesMuettes = new Map();
  const parSession = construireParSession(boxes);

  for (let prises = 0; prises < reglages.lettresParTournee; prises += 1) {
    let prise;
    try {
      prise = prendreUneLettre(db, { porteur, maintenant: horloge(), reglages, seulementLaLettre });
    } catch (erreur) {
      // ⚠️ LE BUREAU EST FERMÉ (verrouillé, en lecture seule, disque plein).
      // AUCUNE boîte n'est touchée : une remise qu'on ne saura pas marquer
      // repartirait à chaque tournée, pour toujours.
      journal({
        evenement: "facteur_bureau_ferme",
        code: erreur?.code || null,
        detail: String(erreur?.message || erreur)
      });
      noter("bureau-ferme");
      break;
    }
    if (!prise) {
      // ⚠️ UN FILTRE QUI NE TROUVE RIEN NE PORTE RIEN — et il le DIT. Se rabattre
      // en silence sur « alors je prends tout » serait le pire défaut possible de
      // ce mode ; se taire serait indiscernable d'un bureau vide.
      if (seulementLaLettre && bilan.prises === 0) {
        const etat = etatDuCourrier(db, seulementLaLettre, { maintenant: horloge() });
        noter(etat ? "lettre-non-prise" : "lettre-introuvable");
        journal({ evenement: "facteur_lettre_non_prise", msg_id: seulementLaLettre, etat: etat || null });
      }
      break;
    }

    bilan.prises += 1;
    const { attemptId, lettre } = prise;

    try {
      const acheminement = trouverLaBoite(db, lettre, { parSession, houses, resoudre });
      // Une lettre déposée avant l'alias : le Facteur est le premier à le voir.
      if (acheminement.alias) {
        journaliserAlias(db, lettre, {
          alias: acheminement.alias,
          kind: acheminement.motif || "livrable",
          targets: acheminement.cible ? [acheminement.cible] : []
        }, porteur);
      }
      if (!acheminement.boite) {
        // Le constat AVANT l'échec : la dernière ligne de la lettre reste celle de
        // son ajournement (ce que lit quiconque demande « pourquoi attend-elle »).
        if (acheminement.motif === "lignee-ambigue") direSansChaiseDesigneeUneFois(db, lettre, acheminement, porteur, journal);
        const reprise = noterLEchec(db, {
          attemptId,
          msgId: lettre.msg_id,
          motif: acheminement.motif,
          permanent: false,
          ajournementMs: reglages.ajournementInacheminableMs,
          plafondMs: reglages.ajournementMaximalMs,
          porteur,
          maintenant: horloge()
        });
        bilan.ajournees += 1;
        noter(acheminement.motif);
        journal({
          evenement: "facteur_inacheminable",
          msg_id: lettre.msg_id,
          motif: acheminement.motif,
          maison: acheminement.maison || null,
          candidats: acheminement.candidats || null,
          reprise_apres_ms: reprise
        });
        continue;
      }

      const boite = acheminement.boite;

      // ── LE PLAFOND DE POLITESSE ─────────────────────────────────────────
      // Cette boîte a déjà reçu tout ce qu'une fenêtre lui accorde : on se TAIT
      // pour elle. Les lettres qui lui sont dues sont ajournées ENSEMBLE jusqu'à
      // la fin de la fenêtre, et leur nombre s'écrit UNE fois. Aucune n'est
      // marquée, aucune n'est accusée, aucune n'est perdue — elles restent DUES,
      // et le silence se lève tout seul.
      const sature = boitesMuettes.get(boite.sessionId) || boiteSaturee(db, {
        sessionId: boite.sessionId,
        maintenant: horloge(),
        reglages
      });
      if (sature) {
        const maintenantSilence = horloge();
        noterLEchec(db, {
          attemptId,
          msgId: lettre.msg_id,
          motif: "plafond-boite",
          permanent: false,
          // L'heure du retour est connue : la fin de la fenêtre, pas un
          // doublement. Ce n'est pas la lettre qui a échoué.
          ajournementMs: Math.max(1, sature.jusqua - maintenantSilence),
          croissant: false,
          porteur,
          maintenant: maintenantSilence
        });
        bilan.ajournees += 1;
        noter("plafond-boite");
        if (!boitesMuettes.has(boite.sessionId)) {
          boitesMuettes.set(boite.sessionId, sature);
          const enAttente = lettresDues(db, lettre.recipient);
          const ajournees = taireLaBoite(db, { destinataire: lettre.recipient, jusqua: sature.jusqua });
          journal({
            evenement: "facteur_plafond_boite",
            cible_session: boite.sessionId,
            maison: boite.house,
            destinataire: lettre.recipient,
            remises_dans_la_fenetre: sature.remises,
            lettres_en_attente: enAttente,
            lettres_ajournees: ajournees,
            silence_jusqua_ms: sature.jusqua
          });
        }
        continue;
      }

      const maintenantLiaison = horloge();
      if (!lierLaBoite(db, { attemptId, boite, maintenant: maintenantLiaison, reglages })) {
        // Le bail a filé entre la prise et la liaison : un autre porteur a la
        // main. On ne touche AUCUNE boîte.
        bilan.ajournees += 1;
        noter("tentative-perimee");
        journal({ evenement: "facteur_tentative_perimee", msg_id: lettre.msg_id, attempt_id: attemptId });
        continue;
      }

      const adresseDuFacteur =
        deps.adresseDuFacteur || adresseDeRecu(boite.socketPath, NOM_DE_LA_BOITE_DU_FACTEUR);
      const contenu = buildWrapper({
        from: adresseDuFacteur,
        fromSession: sessionDeLExpediteur(db, lettre.sender, resoudre),
        hopChain: "facteur",
        fromName: lettre.sender,
        fromMode: "default",
        text: plierLaLettre(lettre, { attemptId })
      });
      const enveloppe = buildEnvelope({
        msgId: lettre.msg_id,
        content: contenu,
        priority: "next", // « now » ne veut pas dire « vu tout de suite » (A5)
        from: adresseDuFacteur,
        // ⚠️ VERROU D'INCARNATION (A3) : la session VISÉE, celle qu'on vient de
        // lier — jamais recalculée après coup.
        sessionId: boite.sessionId
      });

      const verdict = await remettre(
        {
          socketPath: boite.socketPath,
          token: boite.token,
          envelope: enveloppe,
          lingerMs: reglages.delaiDeFermetureMs,
          timeoutMs: reglages.delaiDeRemiseMs
        },
        deps.reseau || {}
      );

      // ⚠️ On se branche sur `ok`, JAMAIS sur `etat` : DEUX états valent succès
      // (`remis-au-guichet` et `remis-au-guichet-fermeture-subie`). Le second est
      // le cas NOMINAL — le destinataire lit sa lettre puis referme sa boîte.
      if (verdict.ok) {
        const marquee = noterLaRemise(db, {
          attemptId,
          msgId: lettre.msg_id,
          cibleSession: boite.sessionId,
          porteur,
          maintenant: horloge(),
          reglages
        });
        if (marquee) {
          bilan.remises += 1;
          noter(verdict.etat);
          journal({
            evenement: "facteur_remis",
            msg_id: lettre.msg_id,
            attempt_id: attemptId,
            etat: verdict.etat,
            cible_session: boite.sessionId,
            maison: boite.house
          });
        } else {
          // La lettre est partie mais ce porteur n'a plus le droit de le dire :
          // son successeur la reportera. Doublon possible, assumé (A8).
          bilan.ajournees += 1;
          noter("tentative-perimee");
          journal({ evenement: "facteur_tentative_perimee", msg_id: lettre.msg_id, attempt_id: attemptId });
        }
      } else {
        // Un échec DÉFINITIF ne se rejoue pas au rythme des passagers : il
        // s'ajourne longtemps et s'écrit. Le canal de repli, lui, sert la lettre
        // pendant ce temps-là.
        const ajournementMs = verdict.permanent
          ? reglages.ajournementEchecDefinitifMs
          : reglages.ajournementTransitoireMs;
        const reprise = noterLEchec(db, {
          attemptId,
          msgId: lettre.msg_id,
          motif: verdict.reason,
          permanent: Boolean(verdict.permanent),
          ajournementMs,
          plafondMs: reglages.ajournementMaximalMs,
          porteur,
          maintenant: horloge()
        });
        bilan.ajournees += 1;
        noter(verdict.reason);
        journal({
          evenement: "facteur_echec",
          msg_id: lettre.msg_id,
          attempt_id: attemptId,
          motif: verdict.reason,
          permanent: Boolean(verdict.permanent),
          detail: verdict.detail || null,
          reprise_apres_ms: reprise
        });
      }

      // ── LE COMPTE-GOUTTES ───────────────────────────────────────────────
      // ⚠️ LA PAUSE SUIT TOUTE TENTATIVE DE DÉPÔT, QUEL QU'EN SOIT LE VERDICT.
      // Le portier du destinataire compte des TENTATIVES, pas des succès — et un
      // portier saturé rend précisément les verdicts d'ÉCHEC. Une pause réservée
      // à la branche du succès laisse donc le chemin de l'échec partir en rafale
      // contre la boîte qui refuse déjà : le défaut se nourrit lui-même.
      if (Number(reglages.pauseEntreRemisesMs) > 0) await dormir(Number(reglages.pauseEntreRemisesMs));
    } catch (erreur) {
      // Le bureau s'est fermé en cours de tournée : on s'arrête là. Le bail de
      // la tentative en cours expirera et la lettre reviendra (A9).
      journal({
        evenement: "facteur_tournee_interrompue",
        msg_id: lettre.msg_id,
        code: erreur?.code || null,
        detail: String(erreur?.message || erreur)
      });
      noter("bureau-ferme");
      break;
    }
  }

  // Le silence ne s'écrit pas : une tournée où rien n'a bougé ne laisse pas de
  // ligne — c'est le battement du démon qui prouve la vie (E4). Une tournée se
  // dit dès que QUELQUE CHOSE s'est passé : une prise, une remise, un
  // ajournement, ou un motif noté (même sans lettre prise).
  if (tourneeBougee(bilan)) journal({ evenement: "facteur_tournee", ...bilan });
  return bilan;
}
