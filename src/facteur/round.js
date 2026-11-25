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
import { enrichirPourAffichage, journaliserAlias, recordEvent } from "../lib/database.js";
import {
  ETAT_NON_REMIS,
  adresseDeRecu,
  buildEnvelope,
  buildWrapper,
  remettreAuGuichet as remettreAuGuichetReel
} from "../lib/courier.js";
import { isKnownHouse, tourHouses as tourHousesReelle } from "../lib/postbox.js";
import { attenteDeLaLettre, resolveRecipient as resolveRecipientReel } from "../lib/registry.js";
import { fichesCodex as fichesCodexReelles } from "../lib/chaise-codex.js";
import { leBalayageEstDu, retournerLesLettres } from "./retour.js";
import { enveloppeDeSonnette } from "../lib/sonnette.js";
// Les RÈGLES de la porte Codex, jamais son lanceur : ce module est chargé par la
// porte web (serveur.js → guichet.js → round.js), qui ne lance rien. La porte
// elle-même (porte-codex.js) arrive par `deps.sonnerLaChaiseCodex`, tendue par
// le démon et le one-shot du Facteur.
import {
  DELAI_SONNETTE_MS,
  MOTIF_SONNETTE_DEJA_SONNEE,
  MOTIF_SONNETTE_DIFFEREE,
  MOTIF_SONNETTE_IMPOSSIBLE,
  PORTE_CODEX_ABSENTE,
  lienDuFil,
  ouvertureReussie,
  ouvertureTentee
} from "./porte-codex-regles.js";

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
// La lettre calme (1.1.0, `sans_reveil = 1`) n'est pas un cinquième état : c'est une décision du
// guichet, lue sur la ligne, que la sélection de la tournée exclut (`prendreUneLettre`).
export function lettreCalme(db, msgId) {
  const ligne = db.prepare("SELECT sans_reveil FROM messages WHERE msg_id = ?").get(msgId);
  return Number(ligne?.sans_reveil) === 1;
}

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
  // LA LETTRE CALME NE SE PORTE PAS (1.1.0, spec A §4, spec B §4). `sans_reveil = 1` est la décision
  // du guichet pour une lettre de TABLE (`deciderLeReveil` : priorité LOW, table ou membre en
  // `prochain-tour`, réaction en mode direct) ; une lettre ordinaire naît à 0 et se porte comme en
  // 1.0.0. La lettre calme arrive par SessionStart, PostToolUse et `inbox`, jamais par une
  // sonnette. Elle n'est donc ni prise, ni tentée, ni marquée `carried_at` — et elle ne passe pas
  // derrière le curseur du balayage : elle n'est simplement jamais candidate. Rien n'est perdu
  // (A9) : le canal de repli (`getPendingForContext`) la sert comme les autres.
  const choisir = db.prepare(`
    SELECT m.*
    FROM messages m
    LEFT JOIN facteur_attempts a
      ON a.msg_id = m.msg_id
     AND a.state IN ${TENTATIVES_ACTIVES}
     AND a.lease_until_ms > @maintenant
    JOIN facteur_sweep s ON s.singleton = 1
    WHERE m.acked_at IS NULL
      AND m.sans_reveil = 0
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
// `porteeA` (B17) : l'instant où la lettre est vraiment partie, quand il n'est
// pas `maintenant` — une sonnerie Codex porte TOUTES les lettres de son
// enveloppe à son instant à elle, pas à celui de chaque remise.
export function noterLaRemise(db, { attemptId, msgId, cibleSession, porteur, maintenant, reglages, porteeA = null }) {
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
    `).run(new Date(Number.isFinite(porteeA) ? porteeA : maintenant).toISOString(), maintenant + ajournement, msgId);
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
export function trouverLaBoite(db, lettre, { parSession, houses, resoudre, fichesCodex = new Map() }) {
  const resolution = resoudre(db, lettre.recipient);
  // L'alias voyage avec CHAQUE verdict, livrable ou non : c'est ce qui permet
  // à la tournée de le journaliser, et à un avis de dire où la lettre attend.
  const avec = (verdict) => (resolution.alias ? { ...verdict, alias: resolution.alias } : verdict);
  if (resolution.kind === "unknown") {
    return avec({ motif: "destinataire-inconnu" });
  }
  // À PORTER (relais) : le destinataire vit sur l'autre Mac. Ce n'est pas un
  // inconnu : le Facteur n'a aucune boîte à sonner ici, il ajourne la lettre
  // sous son vrai motif, et c'est le relais qui la porte.
  if (resolution.kind === "distant") {
    return avec({ motif: "a-porter", mac: resolution.mac });
  }
  if (resolution.kind === "ambigu") {
    // La lettre ATTEND. Trancher soi-même, c'est un tirage au sort déguisé, et
    // le prix du tirage c'est une lettre lue par la mauvaise personne.
    // LA CHAISE COURTE AMBIGUË (1.1.0, Tâche 8) n'est pas une lignée ambiguë :
    // une désignation n'y change rien, c'est le préfixe qu'il faut allonger —
    // le même motif que l'avis du guichet (`attenteDeLaLettre`).
    if (resolution.abrege) return avec({ motif: "chaise-ambigue", candidats: resolution.targets.length });
    return avec({ motif: "lignee-ambigue", candidats: resolution.targets.length });
  }
  const cible = resolution.targets[0];
  const session = cible?.instance_session_id || null;
  if (!session) return avec({ motif: "chaise-sans-session" });

  // LA PORTE CODEX (1.1.0, spec B §2) : une chaise Codex n'a pas de boîte native.
  // Sa fiche (`<bureau>/codex/<lignée>.json`, écrite par notre hook SessionStart)
  // dit son fil et son CODEX_HOME, et c'est `codex queue` qui sonne. La fiche se
  // cherche par le FIL, qui EST la session inscrite au registre
  // (`instance_session_id = thread_id`) — jamais par le nom, qu'une autre chaise
  // de la même lignée pourrait porter — et elle ne vaut que pour la lignée
  // qu'elle nomme. La porte lit le fil et le CODEX_HOME dans la FICHE, jamais
  // sur la carte (que le serveur MCP nu de la chaise réécrit). Avant la boîte
  // native : une chaise Codex n'écrit jamais de `sessions/<pid>.json`.
  const fiche = fichesCodex?.get?.(String(session));
  if (fiche && (!cible.lineage || fiche.lineage === cible.lineage)) {
    return avec({ type: "codex", fiche, cible, session });
  }

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

// Les fiches Codex d'une tournée, par FIL : la carte `thread_id → fiche`, construite
// une fois par tournée comme `parSession`. Une fiche moissonnée (`dead_at`) ou sans
// CODEX_HOME n'est pas une porte : `lierLaBoite` exige une maison (CHECK de
// `facteur_attempts`), et on ne sonne pas un processus qu'un docteur a constaté mort.
export function construireFichesCodex(fiches) {
  const parFil = new Map();
  for (const fiche of Array.isArray(fiches) ? fiches : []) {
    if (!fiche?.thread_id || !fiche?.codex_home || fiche.dead_at) continue;
    const fil = String(fiche.thread_id);
    if (!parFil.has(fil)) parFil.set(fil, fiche);
  }
  return parFil;
}

// La chaise Codex, dans la forme d'une boîte : c'est ce que `lierLaBoite` écrit
// comme cible durable (maison = CODEX_HOME, session = fil, chemin = le lien du fil)
// et ce que le plafond de politesse compte (par session). Pas de jeton, pas d'heure
// de démarrage : aucune socket n'est frappée. Le pid est celui de la fiche, pour
// le récit seulement — aucune décision ne le lit.
export function boiteDeLaFicheCodex(fiche) {
  return {
    house: String(fiche.codex_home),
    sessionId: String(fiche.thread_id),
    procStart: null,
    socketPath: lienDuFil(fiche.thread_id),
    token: null,
    name: fiche.lineage || null,
    pid: fiche.pid ?? null,
    kind: "codex"
  };
}

// Lire les fiches Codex sans jamais casser une tournée, un scan ni un avis : un
// dossier `codex/` illisible donne zéro fiche, et le journal le dit.
function lireLesFichesCodexSansCasser(db, lire, journal = () => {}) {
  try {
    const fiches = lire(db);
    return Array.isArray(fiches) ? fiches : [];
  } catch (erreur) {
    journal({ evenement: "facteur_fiches_codex_illisibles", detail: String(erreur?.message || erreur) });
    return [];
  }
}

// La tournée des maisons, prête à servir `trouverLaBoite` — MÊME defaults
// que la tournée réelle (`tourHousesReelle`, `maisonsConnues`), pour qu'un
// appelant hors du démon (le guichet MCP, le CLI) obtienne EXACTEMENT ce
// que la prochaine tournée du Facteur verrait, pas une approximation.
export function scannerLesMaisons(deps = {}) {
  const tournerLesMaisons = deps.tourHouses || tourHousesReelle;
  const { boxes, houses } = tournerLesMaisons(deps.maisons || maisonsConnues({ env: deps.env || process.env }));
  // Les fiches Codex font partie de l'inventaire (1.1.0) : la prochaine tournée
  // sonnera ces chaises. Elles se lisent au bureau du processus (le dossier
  // `codex/` à côté de la base) ; la base, quand elle est là, ne sert qu'au
  // résumé de la carte. Illisibles : aucune, jamais une exception.
  const fiches = lireLesFichesCodexSansCasser(deps.db || null, deps.fichesCodex || fichesCodexReelles);
  return { houses, parSession: construireParSession(boxes), fichesCodex: construireFichesCodex(fiches) };
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

// LA CHAISE CODEX (1.1.0) : livrable par la porte Codex, donc le silence. Un appelant
// qui tient déjà les fiches de son scan (`scannerLesMaisons`) les tend
// (`fichesCodex`, une Map qui fait foi) ; sans elles, l'avis les lit au bureau
// lui-même — le guichet (`posterUneLettre`), `broadcast` et `envoi_status` ne
// tendent que {houses, parSession}, et ils diraient sinon « maison inconnue »
// d'une chaise que la prochaine tournée va sonner.
export function avisDAttente(db, lettre, { parSession, houses, resoudre, resolutionExistante = null, fichesCodex = null } = {}) {
  const avisRegistre = attenteDeLaLettre(db, lettre.recipient, resolutionExistante);
  if (avisRegistre) return avisRegistre;
  try {
    const resoudreGele = resolutionExistante ? () => resolutionExistante : resoudre;
    const fiches =
      fichesCodex instanceof Map ? fichesCodex : construireFichesCodex(lireLesFichesCodexSansCasser(db, fichesCodexReelles));
    const acheminement = trouverLaBoite(db, lettre, { parSession, houses, resoudre: resoudreGele, fichesCodex: fiches });
    if (acheminement.boite || acheminement.type === "codex") return null; // livrable : le silence des cas sains
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

// ── LA PORTE CODEX (1.1.0, spec B) ─────────────────────────────────────────
// Une chaise Codex n'a pas de boîte native : on la SONNE (`codex queue`) avec
// une enveloppe — jamais un corps — et le modèle relève lui-même sa boîte
// (`inbox`). Quatre règles, toutes de la spec :
//   · UNE sonnerie par chaise et par tournée : les lettres qui attendent
//     ensemble partent dans la même enveloppe (« N letters waiting »), et les
//     suivantes de la tournée reprennent le verdict de la première — un
//     `codex` qui pend ne se refrappe pas N fois à cinq secondes pièce, et une
//     lettre qui n'a frappé à aucune porte ne paie pas la pause. ⚠️ Un verdict
//     RÉUSSI ne vaut que pour les lettres que l'enveloppe NOMMAIT (revue de la
//     Tâche 10, constat 4) : une lettre arrivée pendant la sonnerie, ou venue
//     sous une autre adresse de la même chaise, marquée portée sur ce verdict,
//     ne sonnerait jamais. Elle attend la tournée suivante
//     (`sonnette-codex-differee`, échéance d'un échec passager). Un verdict
//     d'ÉCHEC, lui, vaut pour toute lettre du fil ;
//   · UNE sonnerie par lettre au plus : une lettre déjà `carried_at` ne resonne
//     JAMAIS (motif `sonnette-codex-deja-sonnee`, échéance FINIE : A9 tient, ce
//     sont les hooks qui la re-servent au prochain tour — « pas de rafale
//     tardive ») ;
//   · UNE ouverture de l'app au plus par lettre : une sonnerie qui l'a tentée
//     le note sur chacune de ses lettres qui n'en avaient pas encore
//     (`facteur_codex_app_ouverte`, la base garde, jamais un drapeau en
//     mémoire ; S11 : une tentative par lettre, et le journal du Facteur dit
//     l'ouverture une fois par enveloppe). Le droit se juge PAR LETTRE NEUVE
//     (A4, passe adverse) : une enveloppe la retente tant qu'une de ses lettres
//     n'en a jamais eu — une ancienne lettre déjà tentée ne supprime pas le
//     droit d'une neuve qui voyage avec elle ; une enveloppe dont chaque lettre
//     a eu la sienne ne la retente pas. Une lettre portée ne resonne pas :
//     `carried_at` ferme déjà le cas nominal ; la note ferme celui où la file a
//     refusé ;
//   · un échec est un motif, `sonnette-codex-impossible`, reporté comme un
//     échec passager : la lettre attend, le canal de repli la sert.
// Le verdict a la forme de celui du guichet natif (`ok`, `etat` | `reason`,
// `permanent`, `detail`) pour que la queue de la tournée — remise, échec,
// journal — soit la MÊME pour les deux portes. `ajournementMs`, quand il est là,
// dit l'échéance à poser au lieu de la déduire de `permanent` ; `frappe: false`
// dit qu'aucune porte n'a été frappée pour cette lettre.
const EVENEMENT_APP_OUVERTE = "facteur_codex_app_ouverte";

// Les adresses qui mènent à CETTE chaise : celles des lettres qui pourraient
// sonner, que la résolution de la tournée (`resoudre`, la même que
// `trouverLaBoite`) ramène à une cible unique, dont la session est ce fil. Une
// lettre à la chaise sous son adresse entière, ou sous un ancien nom, voyage
// donc dans la même enveloppe que celle adressée à la lignée — et une lignée
// ambiguë n'y entre jamais. La lettre en main y est toujours.
function adressesDeLaChaise(db, { lettre, fil, resoudre }) {
  const adresses = new Set([String(lettre.recipient)]);
  const candidates = db
    .prepare("SELECT DISTINCT recipient FROM messages WHERE acked_at IS NULL AND sans_reveil = 0 AND carried_at IS NULL")
    .all()
    .map((ligne) => String(ligne.recipient));
  for (const adresse of candidates) {
    if (adresses.has(adresse)) continue;
    try {
      const resolution = resoudre(db, adresse);
      const [cible] = resolution.targets || [];
      if (resolution.kind !== "ambigu" && resolution.targets.length === 1 && String(cible?.instance_session_id) === fil) {
        adresses.add(adresse);
      }
    } catch {
      /* une adresse que le registre ne sait pas lire n'entre pas dans l'enveloppe */
    }
  }
  return [...adresses];
}

// Les lettres que CETTE sonnerie couvre : celles de la chaise qui réveillent
// (`sans_reveil = 0`), jamais portées, et que la tournée peut prendre
// maintenant (échéance passée, aucune tentative en main) — plus la lettre en
// main. La plus urgente d'abord, puis la plus ancienne : l'enveloppe décrit sa
// PREMIÈRE ligne (sonnette.js), le même ordre que `parUrgence`.
function lettresASonner(db, { lettre, adresses, maintenant }) {
  const trous = adresses.map(() => "?").join(", ");
  return db
    .prepare(`
      SELECT m.* FROM messages m
      WHERE m.recipient IN (${trous})
        AND m.acked_at IS NULL
        AND m.sans_reveil = 0
        AND m.carried_at IS NULL
        AND (
          m.msg_id = ?
          OR (
            m.facteur_not_before_ms <= ?
            AND NOT EXISTS (
              SELECT 1 FROM facteur_attempts a
              WHERE a.msg_id = m.msg_id AND a.state IN ${TENTATIVES_ACTIVES} AND a.lease_until_ms > ?
            )
          )
        )
      ORDER BY CASE m.priority
                 WHEN 'critical' THEN 3
                 WHEN 'high' THEN 2
                 WHEN 'normal' THEN 1
                 WHEN 'low' THEN 0
                 ELSE 1
               END DESC, m.seq ASC
    `)
    .all(...adresses, String(lettre.msg_id), maintenant, maintenant);
}

// Ce qui attend déjà la chaise en plus de cette sonnerie, sous toutes ses adresses.
function lettresDuesALaChaise(db, adresses) {
  const trous = adresses.map(() => "?").join(", ");
  const ligne = db
    .prepare(`SELECT count(*) AS n FROM messages WHERE recipient IN (${trous}) AND acked_at IS NULL`)
    .get(...adresses);
  return Number(ligne?.n || 0);
}

// Les lettres de l'enveloppe qui ont encore droit à leur ouverture (A4) : celles
// qui n'en ont jamais eu. Une seule suffit pour ouvrir ; c'est sur elles, et sur
// elles seules, que la tentative se note (S11 : une tentative par lettre — une
// ancienne lettre couverte par l'ouverture d'une neuve n'en reçoit pas une seconde).
function lettresADroitALOuverture(db, rows) {
  const lire = db.prepare("SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = ? LIMIT 1");
  return rows.filter((row) => !lire.get(row.msg_id, EVENEMENT_APP_OUVERTE));
}

async function sonnerLaPorteCodex(db, { fiche, lettre, sonneries, sonner, reglages, journal, porteur, maintenant, seulementLaLettre, resoudre, horloge = () => Date.now() }) {
  if (lettre.carried_at) {
    return {
      ok: false,
      etat: ETAT_NON_REMIS,
      reason: MOTIF_SONNETTE_DEJA_SONNEE,
      permanent: false,
      detail: null,
      ajournementMs: reglages.ajournementApresRemiseMs,
      frappe: false
    };
  }
  const fil = String(fiche.thread_id);
  const memo = sonneries.get(fil);
  if (memo) {
    if (!memo.verdict.ok || memo.couvertes.has(String(lettre.msg_id))) return { ...memo.verdict, frappe: false };
    return {
      ok: false,
      etat: ETAT_NON_REMIS,
      reason: MOTIF_SONNETTE_DIFFEREE,
      permanent: false,
      detail: null,
      ajournementMs: reglages.ajournementTransitoireMs,
      frappe: false
    };
  }

  // Le mode une-lettre ne sonne que pour la lettre demandée : les autres
  // resteraient sonnées sans être portées.
  const adresses = seulementLaLettre ? [String(lettre.recipient)] : adressesDeLaChaise(db, { lettre, fil, resoudre });
  const enAttente = seulementLaLettre ? [] : lettresASonner(db, { lettre, adresses, maintenant });
  const rows = enAttente.length > 0 ? enAttente : [lettre];
  const autres = Math.max(0, lettresDuesALaChaise(db, adresses) - rows.length);
  const enveloppe = enveloppeDeSonnette(enrichirPourAffichage(db, rows), {
    destinataire: fiche.lineage || lettre.recipient,
    autresNonLues: autres
  });
  const aDroit = lettresADroitALOuverture(db, rows);
  const ouvrirApp = reglages.ouvrirLAppCodex !== false && aDroit.length > 0;
  // Le couperet de chaque enfant suit le délai d'un dépôt : la porte entière
  // (deux délais) tient alors dans le bail que `verifierLesReglages` garantit
  // plus long qu'un dépôt et sa marge.
  const delaiMs = Math.min(DELAI_SONNETTE_MS, Number(reglages.delaiDeRemiseMs) || DELAI_SONNETTE_MS);
  let resultat;
  try {
    resultat = await sonner({ fiche, enveloppe, ouvrirApp, delaiMs });
  } catch (erreur) {
    // La porte promet de ne jamais lever ; si elle le fait quand même, c'est un
    // échec de sonnette, pas une tournée interrompue.
    resultat = { ok: false, mode: null, erreur: String(erreur?.code || erreur?.message || erreur) };
  }
  if (ouvertureTentee(resultat)) {
    const ok = ouvertureReussie(resultat);
    // La tentative se note sur les lettres qui y avaient droit, une fois chacune ;
    // le journal dit l'ouverture de l'app UNE fois pour l'enveloppe, pour qui, et
    // combien de lettres elle couvre (S11).
    for (const row of aDroit) recordEvent(db, row.msg_id, porteur, EVENEMENT_APP_OUVERTE, { thread_id: fil, ok });
    journal({
      evenement: EVENEMENT_APP_OUVERTE,
      lignee: fiche.lineage || null,
      thread_id: fil,
      ok,
      pour: aDroit.map((row) => String(row.msg_id)),
      lettres: rows.length
    });
  }
  // B17 (marche Codex) : l'instant de la sonnerie, lu quand la porte a rendu
  // la main — celui que chaque lettre de l'enveloppe portera (`carried_at`),
  // même remise après la pause entre remises.
  const verdict = resultat?.ok
    ? { ok: true, etat: resultat.mode === "queue+open" ? "sonnee-codex-app-ouverte" : "sonnee-codex", sonneeA: horloge() }
    : { ok: false, etat: ETAT_NON_REMIS, reason: MOTIF_SONNETTE_IMPOSSIBLE, permanent: false, detail: resultat?.erreur || null };
  sonneries.set(fil, { verdict, couvertes: new Set(rows.map((row) => String(row.msg_id))) });
  // Jamais l'enveloppe au journal : elle cite un sujet.
  journal({
    evenement: "facteur_sonnette_codex",
    lignee: fiche.lineage || null,
    thread_id: fil,
    porte: fiche.porte || null,
    lettres: rows.length,
    autres_non_lues: autres,
    ouvrir_app: ouvrirApp,
    ok: Boolean(resultat?.ok),
    mode: resultat?.mode || null,
    erreur: resultat?.erreur || null
  });
  return verdict;
}

// La tournée à qui personne n'a tendu la porte Codex : un verdict, jamais un
// lancement. Le démon et le one-shot la tendent toujours (daemon.js, bin/facteur.js).
async function porteCodexAbsente() {
  return { ok: false, mode: null, erreur: PORTE_CODEX_ABSENTE };
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
  const sonner = deps.sonnerLaChaiseCodex || porteCodexAbsente;
  const lireLesFichesCodex = deps.fichesCodex || fichesCodexReelles;
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
  // Les fiches Codex se relisent aussi à chaque tournée (une chaise Codex née
  // après le démarrage du démon doit être vue), et les sonneries de CETTE
  // tournée se souviennent : une par fil, quel que soit le nombre de lettres.
  const fichesCodex = construireFichesCodex(lireLesFichesCodexSansCasser(db, lireLesFichesCodex, journal));
  const sonneriesCodex = new Map();

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
        // UNE LETTRE CALME SE DIT (1.1.0, revue T4) : `prendreUneLettre` ne la prend jamais, alors
        // que son état de Facteur peut être PRÊTE (ni réservée, ni différée). Le journal porte
        // `calme: true` pour qu'un « pourquoi pas portée » ne lise jamais un PRÊTE nu ; absent sinon.
        const calme = etat ? lettreCalme(db, seulementLaLettre) : false;
        journal({ evenement: "facteur_lettre_non_prise", msg_id: seulementLaLettre, etat: etat || null, ...(calme ? { calme: true } : {}) });
      }
      break;
    }

    bilan.prises += 1;
    const { attemptId, lettre } = prise;

    try {
      const acheminement = trouverLaBoite(db, lettre, { parSession, houses, resoudre, fichesCodex });
      // Une lettre déposée avant l'alias : le Facteur est le premier à le voir.
      if (acheminement.alias) {
        journaliserAlias(db, lettre, {
          alias: acheminement.alias,
          kind: acheminement.motif || "livrable",
          targets: acheminement.cible ? [acheminement.cible] : []
        }, porteur);
      }
      const ficheCodex = acheminement.type === "codex" ? acheminement.fiche : null;
      if (!acheminement.boite && !ficheCodex) {
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

      // La chaise Codex se LIE comme une boîte (maison = CODEX_HOME, session =
      // fil) : même bail, même plafond de politesse, même clôture.
      const boite = ficheCodex ? boiteDeLaFicheCodex(ficheCodex) : acheminement.boite;

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

      let verdict;
      if (ficheCodex) {
        verdict = await sonnerLaPorteCodex(db, {
          fiche: ficheCodex,
          lettre,
          sonneries: sonneriesCodex,
          sonner,
          reglages,
          journal,
          porteur,
          maintenant: horloge(),
          seulementLaLettre,
          resoudre,
          horloge
        });
      } else {
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

        verdict = await remettre(
          {
            socketPath: boite.socketPath,
            token: boite.token,
            envelope: enveloppe,
            lingerMs: reglages.delaiDeFermetureMs,
            timeoutMs: reglages.delaiDeRemiseMs
          },
          deps.reseau || {}
        );
      }

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
          reglages,
          porteeA: verdict.sonneeA ?? null
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
        // La porte Codex sait parfois l'échéance qu'elle veut (une lettre déjà
        // sonnée revient au rythme d'une remise, pas d'un échec passager).
        const ajournementMs =
          verdict.ajournementMs ??
          (verdict.permanent ? reglages.ajournementEchecDefinitifMs : reglages.ajournementTransitoireMs);
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
      // Une lettre Codex qui reprend le verdict de sa chaise, ou déjà sonnée, n'a
      // frappé à AUCUNE porte : elle ne paie pas la pause (`frappe: false`).
      if (verdict.frappe !== false && Number(reglages.pauseEntreRemisesMs) > 0) {
        await dormir(Number(reglages.pauseEntreRemisesMs));
      }
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

  // ── LE RETOUR À L'EXPÉDITEUR (1.1.0, Tâche 3) ───────────────────────────
  // Une lettre vers un nom que personne n'a JAMAIS porté revient à son expéditeur après
  // `retourApresMs` (retour.js). Le balayage lit le bureau, pas la sélection ci-dessus : une
  // lettre ajournée ou calme revient aussi, et une lettre écrite sans le serveur MCP aussi.
  // Jamais en mode une-lettre (la cérémonie ne porte que la lettre demandée), jamais sur un
  // bureau fermé, jamais quand les retours sont éteints (`VALXOS_RETOUR_APRES_S=0`) ; un
  // balayage qui casse se dit et ne casse pas la tournée. Le démon tend sa mémoire
  // (`memoireDuRetour`) : il balaie au plus une fois par minute, pas à chaque tournée.
  const maintenantDuRetour = horloge();
  if (
    !seulementLaLettre &&
    !bilan.motifs["bureau-ferme"] &&
    Number(reglages.retourApresMs) > 0 &&
    leBalayageEstDu(deps.memoireDuRetour, maintenantDuRetour)
  ) {
    try {
      const retournees = retournerLesLettres(db, {
        maintenant: maintenantDuRetour,
        retourApresMs: reglages.retourApresMs,
        porteur,
        journal,
        resoudre
      });
      if (retournees > 0) bilan.motifs["retour-a-l-expediteur"] = retournees;
    } catch (erreur) {
      journal({
        evenement: "facteur_retour_impossible",
        code: erreur?.code || null,
        detail: String(erreur?.message || erreur)
      });
    }
  }

  // Le silence ne s'écrit pas : une tournée où rien n'a bougé ne laisse pas de
  // ligne — c'est le battement du démon qui prouve la vie (E4). Une tournée se
  // dit dès que QUELQUE CHOSE s'est passé : une prise, une remise, un
  // ajournement, ou un motif noté (même sans lettre prise).
  if (tourneeBougee(bilan)) journal({ evenement: "facteur_tournee", ...bilan });
  return bilan;
}
