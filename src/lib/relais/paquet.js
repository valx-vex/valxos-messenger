// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE PAQUET DU RELAIS (schéma 8) — ce qu'un bureau donne à l'autre Mac, et ce
// qu'il en reçoit.
//
// Chaque Mac garde son bureau. Un paquet est du JSON qui traverse un tube
// (ssh) : `{ version, schema, de, pour, lettres, evenements, chaises }`.
//   · `lettres` : les lettres nées ici, non accusées, pas encore portées, que
//     la résolution d'ici dit « à porter » vers CE Mac (`kind: "distant"`) —
//     dans l'ordre des `seq`, au plus `limite` ;
//   · `evenements` : ce que l'autre Mac doit apprendre de ses lettres — la
//     remise puis l'accusé des lettres arrivées de lui, et l'accusé des
//     lettres nées ici, offertes à lui, et accusées ICI (rulings R16, R20).
//     Chaque évènement dit où sa lettre est née (`origine`) ;
//   · `chaises` : les chaises d'ici en service, pour son carnet.
//
// LES QUATRE LOIS DU PAQUET
//   1. Une lettre arrivée par le relais (`via = 'relais'`) ne repart JAMAIS :
//      le ping-pong entre deux Macs qui se croient chacun ailleurs est fermé
//      ici, pas par la résolution.
//   2. L'import est idempotent sur `msg_id` : la même lettre deux fois est un
//      rejeu sans effet. Un `msg_id` connu avec un AUTRE contenu n'est jamais
//      un rejeu silencieux : la lettre locale reste intacte, le conflit se
//      compte et s'écrit au journal (`relais_conflit`), avec ce qui a été
//      écarté — rien ne s'efface (Camp B). Un refus (ce conflit, ou l'enclos
//      de ce bureau) ne vaut que pour SA lettre : elle est rendue dans
//      `refus`, l'autre Mac ne la marque pas portée, et les suivantes
//      arrivent quand même (ruling R18). Le refus revient sur la lettre
//      d'origine, chez son expéditeur (`relais_refus`, `noterLesRefus`, R29).
//   3. La remise passe toujours avant l'accusé, et un accusé reçu pose la
//      remise s'il ne l'a pas encore : jamais « accusée » sans « reçue ».
//   4. Un pas qui échoue ne marque rien : le paquet se vérifie EN ENTIER, champ
//      par champ, avant la première écriture, et les CONFIRMATIONS de l'aller
//      (`porte_at`) et du retour (`*_rendu_at`) se posent par des fonctions à
//      part, appelées seulement quand l'autre Mac a vraiment importé. L'export
//      ne pose que l'OFFRE (`porte_vers`, R20), qui ne marque rien de porté.
//
// R16 — LIVRER SELON LA RÉSOLUTION, ET L'ACCUSÉ DANS LES DEUX SENS. La fenêtre
// où aucun Mac ne tient une lignée (registry.js, `laLigneeEstTenueAilleurs`)
// peut faire porter une lettre vers l'autre Mac, puis la rendre tenue ICI au
// prochain échange. Rien dans ce module ne filtre la livraison locale sur
// `porte_at` : la lettre d'ici reste servie ici si la résolution l'y mène. Et
// quand elle est accusée ici, son accusé part vers le Mac à qui elle a été
// OFFERTE (`porte_vers`, posé à l'export — R20 : la réponse d'une tournée peut
// se perdre après que l'autre Mac a importé, et `porte_at` reste alors nul),
// pour que la copie de là-bas ne reste pas non accusée à jamais — une copie
// que le Facteur de là-bas réessaierait sans fin. Si l'autre Mac n'a jamais
// importé la lettre, l'accusé n'y touche rien, et il se marque rendu ici.
// L'ORIGINE D'UN ÉVÈNEMENT. Le même `msg_id` peut vivre des deux côtés avec
// deux contenus (un conflit, R18). Un évènement dit donc où sa lettre est née,
// et l'import ne l'applique qu'à la contrepartie : une lettre née ici
// (`origine` = ce Mac), ou une copie venue de l'autre (`origine` = lui, `via`
// relais). Jamais l'accusé d'une lettre de là-bas n'accuse la lettre homonyme
// d'ici.
// Pas d'écho : un accusé APPRIS par le relais pose aussi les marques « rendu »
// de la ligne (l'autre Mac le sait, c'est lui qui l'a dit), donc il ne repart
// jamais vers celui qui l'a envoyé.
import { nowIso } from "../config.js";
import { getMessageById, inscrireUneLettre, recordEvent } from "../database.js";
import { posterUneLettre, scannerSansCasser } from "../guichet.js";
import { SCHEMA_VERSION } from "../migrations.js";
import { EN_SERVICE, resolveRecipient } from "../registry.js";
import { ecrireLeCarnet } from "./carnet.js";

export const VERSION_DU_PAQUET = 1;
export const LIMITE_PAR_PAQUET = 200;
const VIA_RELAIS = "relais";
// L'acteur des évènements que le relais écrit au journal.
const ACTEUR = "relais";

// Les champs d'une lettre dans un paquet, et eux seuls : ce que le posteur a
// écrit, son heure, et les drapeaux décidés par le guichet d'origine. Les
// marques d'ici (`via`, `porte_at`, les heures de remise et d'accusé…) ne
// voyagent pas ; un champ en plus dans un paquet reçu est ignoré (il ne peut
// rien ouvrir ici, `hors_enclos` compris).
export const CHAMPS_DE_LA_LETTRE = [
  "msg_id", "sender", "recipient", "thread_id", "subject", "body", "priority", "msg_type", "created_at",
  "sender_model", "envoi_id", "table_nom", "reponse_a", "sans_reveil", "sans_copie", "sender_chaise"
];

const TYPES_D_EVENEMENT = new Set(["remise", "accuse"]);

// Les champs d'une lettre qui peuvent manquer : du texte, ou rien. Les deux
// drapeaux : 0, 1, un booléen, ou rien. Un autre type passerait la
// vérification et casserait l'écriture APRÈS le carnet et les lettres d'avant
// (better-sqlite3 ne lie pas un objet) : il se refuse avant.
const CHAMPS_TEXTE_FACULTATIFS = [
  "thread_id", "subject", "priority", "msg_type", "sender_model", "envoi_id", "table_nom", "reponse_a", "sender_chaise"
];
const DRAPEAUX_DE_LA_LETTRE = ["sans_reveil", "sans_copie"];
const texteOuRien = (valeur) => valeur === undefined || valeur === null || typeof valeur === "string";
const drapeauOuRien = (valeur) => valeur === undefined || valeur === null || valeur === 0 || valeur === 1 || typeof valeur === "boolean";

function erreurDuPaquet(code, message) {
  const erreur = new Error(message);
  erreur.code = code;
  return erreur;
}

const paquetInvalide = (message) => erreurDuPaquet("paquet-invalide", `invalid packet: ${message}`);

// Un nom de Mac : une chaîne non blanche, sans caractère de contrôle ni
// séparateur de ligne — il finit dans l'en-tête d'une lettre (`Via: relais ·
// from: <Mac>`), où un retour à la ligne écrirait une ligne qu'il n'est pas.
export function exigerUnNomDeMac(valeur, role) {
  if (typeof valeur !== "string" || !valeur.trim() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(valeur)) {
    throw erreurDuPaquet("paquet-mal-adresse", `${role} must be a Mac name (a non-blank string without control characters)`);
  }
  return valeur;
}

const texteNonBlanc = (valeur) => typeof valeur === "string" && valeur.trim().length > 0;

// ── EXPORTER ────────────────────────────────────────────────────────────────

// Le paquet de ce bureau pour `mac`, sous une seule transaction. L'export pose
// l'OFFRE et rien d'autre (R20) : `porte_vers = mac` sur chaque lettre du
// paquet qui n'a pas encore d'offre (la première offre gagne ; une offre vers
// un autre Mac n'est jamais réécrite). `porte_at`, la CONFIRMATION, attend
// `marquerPortees`, une fois l'import de là-bas prouvé. Un export qui ne part
// jamais ne coûte rien : si la lettre est accusée ici, son accusé va là-bas,
// où il ne touche aucune lettre, et se marque rendu.
export function exporterPour(db, mac, { moi, limite = LIMITE_PAR_PAQUET } = {}) {
  const pour = exigerUnNomDeMac(mac, "the other Mac");
  const de = exigerUnNomDeMac(moi, "this Mac (moi)");
  if (de === pour) throw erreurDuPaquet("paquet-mal-adresse", `a packet from ${de} cannot be addressed to ${de} itself`);
  if (!Number.isInteger(limite) || limite < 1) {
    throw erreurDuPaquet("paquet-limite-invalide", `limite must be a positive integer (got ${JSON.stringify(limite)})`);
  }
  return db.transaction(() => ({
    version: VERSION_DU_PAQUET,
    schema: SCHEMA_VERSION,
    de,
    pour,
    lettres: lettresAPorter(db, pour, limite),
    evenements: evenementsARendre(db, pour, de),
    chaises: chaisesEnService(db)
  }))();
}

// R37 — LE PAQUET DU DERNIER ÉCHANGE (la veille qui s'arrête). Le même paquet
// que `exporterPour`, SANS LETTRE et sans rien écrire : aucune offre ne se pose
// (`porte_vers`), parce qu'une lettre offerte maintenant serait importée là-bas
// sans que personne n'en rende jamais la confirmation. Il garde ses vrais
// `evenements` (ce que l'autre Mac doit apprendre : remises et accusés) et ses
// vraies `chaises` : l'import de là-bas réécrit son carnet avec la liste
// COMPLÈTE de ce Mac (`ecrireLeCarnet`), et une liste vide y ferait partir
// toutes les fiches d'ici.
export function paquetSansLettres(db, mac, { moi } = {}) {
  const pour = exigerUnNomDeMac(mac, "the other Mac");
  const de = exigerUnNomDeMac(moi, "this Mac (moi)");
  if (de === pour) throw erreurDuPaquet("paquet-mal-adresse", `a packet from ${de} cannot be addressed to ${de} itself`);
  return db.transaction(() => ({
    version: VERSION_DU_PAQUET,
    schema: SCHEMA_VERSION,
    de,
    pour,
    lettres: [],
    evenements: evenementsARendre(db, pour, de),
    chaises: chaisesEnService(db)
  }))();
}

// Les lettres à porter vers `mac`, dans l'ordre des `seq`. La résolution
// décide (une par destinataire distinct, pour tout le paquet) ; une résolution
// qui lève laisse la lettre attendre ici.
function lettresAPorter(db, mac, limite) {
  const candidates = db
    .prepare("SELECT seq, recipient FROM messages WHERE acked_at IS NULL AND via IS NULL AND porte_at IS NULL ORDER BY seq ASC")
    .all();
  const verdicts = new Map();
  const estAPorter = (destinataire) => {
    if (!verdicts.has(destinataire)) {
      let resolution = null;
      try {
        resolution = resolveRecipient(db, destinataire);
      } catch {
        resolution = null;
      }
      verdicts.set(destinataire, resolution?.kind === "distant" && resolution.mac === mac);
    }
    return verdicts.get(destinataire);
  };
  const lire = db.prepare(`SELECT ${CHAMPS_DE_LA_LETTRE.join(", ")} FROM messages WHERE seq = ?`);
  const offrir = db.prepare("UPDATE messages SET porte_vers = ? WHERE seq = ? AND porte_vers IS NULL");
  const lettres = [];
  for (const { seq, recipient } of candidates) {
    if (lettres.length >= limite) break;
    if (!estAPorter(recipient)) continue;
    lettres.push(lire.get(seq));
    offrir.run(mac, seq);
  }
  return lettres;
}

// Ce que `mac` doit apprendre, lettre par lettre dans l'ordre des `seq`, la
// remise d'une lettre toujours avant son accusé.
//   · Les lettres arrivées de `mac` : une `remise` quand `delivered_at` est
//     posé (ruling R19 : `delivered_at` seul, jamais `injected_at`) et que ce
//     n'est pas encore rendu ; un `accuse` quand elle est accusée et que ce
//     n'est pas encore rendu (l'accusé pose la remise là-bas s'il le faut).
//   · R16, R20 : les lettres nées ici, OFFERTES à `mac` (`porte_vers`, confirmé
//     ou non), accusées ICI : un `accuse` (l'import de là-bas pose la remise
//     avec lui, s'il a la copie ; sinon il n'y touche rien).
// `origine` dit où la lettre est née : `mac` pour une copie venue de lui, `moi`
// pour une lettre d'ici. `par` est l'auteur du dernier évènement `acked` ;
// absent quand le journal ne le dit pas.
function evenementsARendre(db, mac, moi) {
  const lignes = db
    .prepare(`
      SELECT msg_id, via, delivered_at, acked_at, remise_rendue_at, accuse_rendu_at
      FROM messages
      WHERE (via = 'relais' AND mac_origine = @mac AND (
               (delivered_at IS NOT NULL AND remise_rendue_at IS NULL)
               OR (acked_at IS NOT NULL AND accuse_rendu_at IS NULL)))
         OR (via IS NULL AND porte_vers = @mac AND acked_at IS NOT NULL AND accuse_rendu_at IS NULL)
      ORDER BY seq ASC
    `)
    .all({ mac });
  const dernierSignataire = db.prepare(
    "SELECT agent_id FROM delivery_events WHERE msg_id = ? AND event_type = 'acked' ORDER BY id DESC LIMIT 1"
  );
  const evenements = [];
  for (const ligne of lignes) {
    const origine = ligne.via === VIA_RELAIS ? mac : moi;
    if (ligne.via === VIA_RELAIS && ligne.delivered_at && !ligne.remise_rendue_at) {
      evenements.push({ type: "remise", msg_id: ligne.msg_id, at: ligne.delivered_at, origine });
    }
    if (ligne.acked_at && !ligne.accuse_rendu_at) {
      const par = dernierSignataire.get(ligne.msg_id)?.agent_id;
      evenements.push({ type: "accuse", msg_id: ligne.msg_id, at: ligne.acked_at, origine, ...(par ? { par } : {}) });
    }
  }
  return evenements;
}

// Les chaises d'ici en service, telles que le carnet de là-bas les attend
// (`ecrireLeCarnet`). Le prédicat est celui de la moitié locale de la règle de
// tenue (`laLigneeEstTenueAilleurs` : une session, le statut EN_SERVICE) :
// les deux Macs comparent ainsi les mêmes faits. Une fiche sans lignée (héritée)
// ne part pas — le carnet de là-bas refuserait tout le lot pour elle.
function chaisesEnService(db) {
  return db
    .prepare(`
      SELECT id, lineage, instance_session_id, is_primary, designe_at FROM peers
      WHERE instance_session_id IS NOT NULL AND trim(instance_session_id) <> ''
        AND lineage IS NOT NULL AND trim(lineage) <> ''
        AND ${EN_SERVICE}
      ORDER BY id ASC
    `)
    .all()
    .map((fiche) => ({
      chaise_id: fiche.id,
      lineage: fiche.lineage,
      instance_session_id: fiche.instance_session_id,
      is_primary: Number(fiche.is_primary) === 1 ? 1 : 0,
      designe_at: fiche.designe_at ?? null
    }));
}

// ── IMPORTER ────────────────────────────────────────────────────────────────

// Le paquet entier se vérifie AVANT la première écriture : une adresse, une
// version, un schéma, puis chaque lettre et chaque évènement. Une lettre sans
// `msg_id` serait la pire : la base lui en inventerait un, et chaque tournée
// la doublerait. Sans `created_at`, elle prendrait l'heure de l'import et
// mentirait sur la sienne.
// Exportée pour la tournée (tournee.js) : la réponse de l'autre Mac se vérifie
// EN ENTIER avant la première marque — une réponse d'une autre version ne
// prouve pas que l'autre Mac a importé ce qu'on lui a donné.
const CHAMPS_EXIGES = ["msg_id", "sender", "recipient", "body", "created_at"];
export function verifierLePaquet(paquet, { de, ici }) {
  if (!paquet || typeof paquet !== "object" || Array.isArray(paquet)) throw paquetInvalide("not an object");
  if (paquet.version !== VERSION_DU_PAQUET) {
    throw erreurDuPaquet("paquet-version", `packet version ${JSON.stringify(paquet.version)} is not ${VERSION_DU_PAQUET}: update the relay on both Macs`);
  }
  if (paquet.schema !== SCHEMA_VERSION) {
    throw erreurDuPaquet("paquet-schema", `packet schema ${JSON.stringify(paquet.schema)} is not ${SCHEMA_VERSION}: update the Messenger on both Macs`);
  }
  if (paquet.de !== de || paquet.pour !== ici) {
    throw erreurDuPaquet(
      "paquet-mal-adresse",
      `packet from ${JSON.stringify(paquet.de)} to ${JSON.stringify(paquet.pour)} is not from ${JSON.stringify(de)} to ${JSON.stringify(ici)}`
    );
  }
  for (const champ of ["lettres", "evenements", "chaises"]) {
    if (!Array.isArray(paquet[champ])) throw paquetInvalide(`${champ} must be an array`);
  }
  const estUnObjet = (valeur) => Boolean(valeur) && typeof valeur === "object" && !Array.isArray(valeur);
  paquet.lettres.forEach((lettre, i) => {
    if (!estUnObjet(lettre)) throw paquetInvalide(`letter ${i} is not an object`);
    for (const champ of CHAMPS_EXIGES) {
      if (!texteNonBlanc(lettre[champ])) throw paquetInvalide(`letter ${i} has no ${champ}`);
    }
    for (const champ of CHAMPS_TEXTE_FACULTATIFS) {
      if (!texteOuRien(lettre[champ])) throw paquetInvalide(`letter ${i}: ${champ} must be a string or null`);
    }
    for (const champ of DRAPEAUX_DE_LA_LETTRE) {
      if (!drapeauOuRien(lettre[champ])) throw paquetInvalide(`letter ${i}: ${champ} must be 0, 1, a boolean or null`);
    }
  });
  paquet.evenements.forEach((evenement, i) => {
    if (!estUnObjet(evenement)) throw paquetInvalide(`event ${i} is not an object`);
    if (!TYPES_D_EVENEMENT.has(evenement.type)) throw paquetInvalide(`event ${i} has an unknown type ${JSON.stringify(evenement.type)}`);
    if (!texteNonBlanc(evenement.msg_id)) throw paquetInvalide(`event ${i} has no msg_id`);
    if (!texteNonBlanc(evenement.at)) throw paquetInvalide(`event ${i} has no at`);
    if (!texteOuRien(evenement.par)) throw paquetInvalide(`event ${i} has a par that is not a string`);
    // Une remise parle toujours d'une lettre née chez qui la reçoit ; un accusé,
    // d'une lettre née sur l'un des deux Macs de ce paquet.
    const origines = evenement.type === "remise" ? [ici] : [ici, de];
    if (!origines.includes(evenement.origine)) {
      throw paquetInvalide(`event ${i} has an origine (${JSON.stringify(evenement.origine)}) that is not ${origines.join(" or ")}`);
    }
  });
  paquet.chaises.forEach((chaise, i) => {
    if (!estUnObjet(chaise)) throw paquetInvalide(`chair ${i} is not an object`);
    if (!texteNonBlanc(chaise.chaise_id)) throw paquetInvalide(`chair ${i} has no chaise_id`);
    if (!texteNonBlanc(chaise.lineage)) throw paquetInvalide(`chair ${i} has no lineage`);
    if (!texteOuRien(chaise.instance_session_id)) throw paquetInvalide(`chair ${i}: instance_session_id must be a string or null`);
    if (!texteOuRien(chaise.designe_at)) throw paquetInvalide(`chair ${i}: designe_at must be a string or null`);
    if (!drapeauOuRien(chaise.is_primary)) throw paquetInvalide(`chair ${i}: is_primary must be 0, 1, a boolean or null`);
  });
}

function champsDeLaLettre(lettre) {
  return Object.fromEntries(CHAMPS_DE_LA_LETTRE.filter((champ) => lettre[champ] !== undefined).map((champ) => [champ, lettre[champ]]));
}

// Un refus s'écrit une fois par lettre, par Mac et par raison : la lettre
// refusée se représente à CHAQUE tournée (R18), le bilan la recompte à chaque
// fois (le rapport le montre), et le journal ne double pas.
function dejaNote(db, msgId, type, mac, raison = null) {
  return Boolean(db
    .prepare(`SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = ? AND json_extract(detail_json, '$.mac') = ?
      ${raison === null ? "" : "AND json_extract(detail_json, '$.raison') = ?"} LIMIT 1`)
    .get(msgId, type, mac, ...(raison === null ? [] : [raison])));
}

// Le conflit : `ecarte` garde la valeur écartée, le contenu de l'autre Mac
// reste lisible ici.
function noterLeConflit(db, msgId, mac, ecarte) {
  if (!dejaNote(db, msgId, "relais_conflit", mac)) {
    recordEvent(db, msgId, ACTEUR, "relais_conflit", { mac, champs: Object.keys(ecarte).sort(), ecarte });
  }
}

// Les refus du guichet d'ici qui ne valent que pour UNE lettre : l'enclos de
// ce bureau (sa politique, que le relais ne contourne pas). Toute autre erreur
// (une base qui ne répond plus…) arrête l'import : c'est la tournée qui échoue.
const REFUS_D_UNE_LETTRE = new Set(["hors-enclos", "enclos-conflit"]);

// Les `msg_id` d'un paquet que l'autre Mac a acceptés : ceux que le Mac qui a
// exporté le paquet marque portés (`marquerPortees`), et eux seuls. `refus`
// est celui du bilan de `importerDe` de là-bas, et il est EXIGÉ : un `refus`
// absent ou cassé (une réponse d'une autre version, une faute de frappe) ne
// vaut jamais « rien de refusé » — ce serait marquer portée une lettre que
// l'autre Mac n'a pas. Il lève `paquet-invalide`, et rien ne se marque.
export function lettresPortees(paquet, refus) {
  if (!Array.isArray(paquet?.lettres)) throw paquetInvalide("the packet has no letters array");
  if (!Array.isArray(refus)) throw paquetInvalide("refus must be the array of the other Mac's import (bilan.refus)");
  const refusees = new Set();
  refus.forEach((r, i) => {
    if (!r || typeof r !== "object" || !texteNonBlanc(r.msg_id)) throw paquetInvalide(`refusal ${i} has no msg_id`);
    refusees.add(r.msg_id);
  });
  return paquet.lettres.map((l) => l.msg_id).filter((id) => !refusees.has(id));
}

/**
 * Importer le paquet de `mac`.
 *
 * L'ordre est fixe : le carnet, puis les lettres une à une dans l'ordre du
 * paquet (par le guichet : il réveille la chaise d'ici, sans code de plus),
 * puis les évènements.
 *
 * Rend `{ neuves, rejeux, conflits, refus, evenements, chaises }` :
 *   · `neuves` : les lettres écrites ici ; `rejeux` : celles qui y étaient
 *     déjà, à l'identique ;
 *   · `refus` : CHAQUE lettre refusée, `{ msg_id, raison }`, dans l'ordre du
 *     paquet (ruling R18). `raison` vaut `"conflit"` (le même `msg_id` existe
 *     ici avec un autre contenu : la lettre d'ici reste intacte, et
 *     `relais_conflit` est au journal) ou le code du refus du guichet d'ici
 *     (`"hors-enclos"`, `"enclos-conflit"` : l'enclos de ce bureau, avec
 *     `relais_refus` `{ mac, raison }` au journal). Un refus ne vaut que pour
 *     sa lettre : les suivantes arrivent quand même ;
 *   · `conflits` : le nombre des refus `"conflit"` ;
 *   · `evenements` : les évènements qui ont changé une lettre d'ici ;
 *   · `chaises` : les chaises inscrites au carnet.
 *
 * LE CONTRAT DE L'ALLER (pour `valxos-relais echanger` et la tournée) : le Mac
 * qui a EXPORTÉ ce paquet ne marque portées (`marquerPortees`) QUE les lettres
 * qui ne sont pas dans `refus` — `lettresPortees(paquet, refus)`. Une lettre
 * refusée reste « en route » sur son Mac d'origine et se représente à chaque
 * tournée ; le rapport de tournée la montre. L'ordre par expéditeur tient pour
 * toute lettre remise ; une lettre refusée puis acceptée plus tard arrive
 * après celles qui la suivaient.
 *
 * LE CONTRAT DU RETOUR (R20) : un `accuse` d'une lettre née sur l'autre Mac
 * (`origine` = lui) touche seulement sa copie ici (`via` relais, venue de
 * lui) ; s'il n'y en a pas — l'autre Mac a offert la lettre sans que ce
 * bureau l'ait importée, ou ce bureau l'a refusée —, il ne touche rien, sans
 * erreur, et l'autre Mac le marque rendu (`marquerRendus`) comme les autres.
 *
 * Une erreur du PAQUET (`paquet-mal-adresse`, `paquet-version`,
 * `paquet-schema`, `paquet-invalide` : chaque champ de chaque lettre, de
 * chaque évènement et de chaque chaise est typé) lève avant toute écriture. Toute autre
 * panne au milieu (la base…) lève avec `paquet_msg_id` : les lettres d'avant
 * sont écrites (un rejeu les retrouvera), les évènements ne sont pas
 * appliqués, et l'autre Mac, qui ne voit pas l'import réussir, ne marque rien.
 *
 * Une lettre déjà présente ici (rejeu ou conflit) ne réveille personne : elle
 * a sonné à son arrivée, et une lettre refusée qui se représente à chaque
 * tournée ne doit pas sonner chez la lettre locale à chaque tournée.
 *
 * `deps` va au guichet (`reveiller`, `resoudre`, `scanner`, `maisons`) ; un
 * seul scan des maisons pour tout le paquet (C1).
 */
export async function importerDe(db, mac, paquet, { moi, at = null, deps = {} } = {}) {
  const de = exigerUnNomDeMac(mac, "the other Mac");
  const ici = exigerUnNomDeMac(moi, "this Mac (moi)");
  if (de === ici) throw erreurDuPaquet("paquet-mal-adresse", `${ici} cannot import a packet from itself`);
  verifierLePaquet(paquet, { de, ici });
  const heure = at || nowIso();

  const { inscrites } = ecrireLeCarnet(db, de, paquet.chaises, { at: heure });
  const bilan = { neuves: 0, rejeux: 0, conflits: 0, refus: [], evenements: 0, chaises: inscrites };

  const maisons = deps.maisons || scannerSansCasser({ scanner: deps.scanner });
  const sansReveil = async () => ({ ok: false, skipped: "relais-deja-la" });
  for (const lettre of paquet.lettres) {
    const entree = { ...champsDeLaLettre(lettre), via: VIA_RELAIS, mac_origine: de };
    const dejaLa = Boolean(getMessageById(db, lettre.msg_id));
    let poste;
    try {
      poste = await posterUneLettre(db, entree, {
        ...deps, maisons, porteParLeRelais: true, ...(dejaLa ? { reveiller: sansReveil } : {})
      });
    } catch (erreur) {
      if (!REFUS_D_UNE_LETTRE.has(erreur?.code)) {
        if (erreur && typeof erreur === "object") erreur.paquet_msg_id = lettre.msg_id;
        throw erreur;
      }
      // L'enclos garde les ÉCRITURES. Une lettre déjà là (une tournée d'avant
      // l'a importée, et sa réponse s'est perdue) n'écrit rien : la base dit si
      // c'est un rejeu ou un conflit (`inscrireUneLettre` sur un `msg_id`
      // connu : ON CONFLICT DO NOTHING), jamais un refus qui la représenterait
      // à chaque tournée alors qu'elle est arrivée.
      const retrouvee = dejaLa ? inscrireUneLettre(db, entree) : null;
      if (!retrouvee || retrouvee.neuve) {
        bilan.refus.push({ msg_id: lettre.msg_id, raison: erreur.code });
        if (!dejaNote(db, lettre.msg_id, "relais_refus", de, erreur.code)) {
          recordEvent(db, lettre.msg_id, ACTEUR, "relais_refus", { mac: de, raison: erreur.code });
        }
        continue;
      }
      poste = { row: retrouvee.row, rejeu: true, ecarte: retrouvee.ecarte };
    }
    const { row, rejeu, ecarte } = poste;
    if (ecarte) {
      bilan.conflits += 1;
      bilan.refus.push({ msg_id: row.msg_id, raison: "conflit" });
      noterLeConflit(db, row.msg_id, de, ecarte);
    } else if (rejeu) {
      bilan.rejeux += 1;
    } else {
      bilan.neuves += 1;
    }
  }

  bilan.evenements = appliquerLesEvenements(db, de, ici, paquet.evenements);
  return bilan;
}

// Les évènements de `mac`, dans l'ordre du paquet, en une transaction. Chacun
// ne touche que la CONTREPARTIE de la lettre de là-bas : `origine` = ce Mac →
// une lettre née ici ; `origine` = `mac` → une copie venue de `mac`. Une ligne
// homonyme d'un autre genre (un conflit) ne bouge pas.
//   · `remise` : seulement sur une lettre née ici — `delivered_at` posé s'il
//     ne l'était pas, et `relais_remise` au journal.
//   · `accuse` : sur une lettre née ici, ou sur la copie d'une lettre que `mac`
//     a accusée chez lui (R16) — d'abord la remise si elle
//     manque, puis l'accusé (COALESCE : une heure posée ne bouge jamais), et
//     `relais_accuse` `{ mac, par }`. Les marques « rendu » de la ligne se
//     posent aussi : `mac` le sait déjà, l'accusé ne lui revient pas en écho.
// Une lettre que ce bureau n'a pas, ou qui n'est pas concernée, ne bouge pas.
// Rend le nombre d'évènements qui ont changé une lettre (remise ou accusé) :
// réimporter le même paquet rend 0 et n'écrit rien.
function appliquerLesEvenements(db, mac, ici, evenements) {
  const lire = db.prepare(
    "SELECT seq, via, mac_origine, delivered_at, acked_at, remise_rendue_at, accuse_rendu_at FROM messages WHERE msg_id = ?"
  );
  const poserLaRemise = db.prepare("UPDATE messages SET delivered_at = ? WHERE seq = ? AND delivered_at IS NULL");
  const poserLAccuse = db.prepare(`
    UPDATE messages SET
      delivered_at = COALESCE(delivered_at, @at),
      acked_at = COALESCE(acked_at, @at),
      accuse_rendu_at = COALESCE(accuse_rendu_at, @at),
      remise_rendue_at = CASE WHEN via = 'relais' THEN COALESCE(remise_rendue_at, @at) ELSE remise_rendue_at END
    WHERE seq = @seq
  `);
  return db.transaction(() => {
    let appliques = 0;
    for (const evenement of evenements) {
      const ligne = lire.get(evenement.msg_id);
      if (!ligne) continue;
      const neeIci = ligne.via === null;
      const venueDeLa = ligne.via === VIA_RELAIS && ligne.mac_origine === mac;
      const contrepartie = evenement.origine === ici ? neeIci : evenement.origine === mac ? venueDeLa : false;
      if (!contrepartie) continue;
      if (evenement.type === "remise") {
        if (neeIci && poserLaRemise.run(evenement.at, ligne.seq).changes > 0) {
          recordEvent(db, evenement.msg_id, ACTEUR, "relais_remise", { mac });
          appliques += 1;
        }
        continue;
      }
      const fait = !ligne.delivered_at || !ligne.acked_at;
      const rendu = !ligne.accuse_rendu_at || (venueDeLa && !ligne.remise_rendue_at);
      if (!fait && !rendu) continue;
      poserLAccuse.run({ at: evenement.at, seq: ligne.seq });
      if (fait) {
        recordEvent(db, evenement.msg_id, ACTEUR, "relais_accuse", { mac, par: evenement.par ?? null });
        appliques += 1;
      }
    }
    return appliques;
  })();
}

// ── MARQUER (quand l'autre Mac a vraiment importé) ──────────────────────────

// Les lettres d'un paquet que `mac` a importé : `porte_at` (la confirmation)
// et `porte_vers` s'il n'y avait pas encore d'offre, une fois (la première
// heure reste), seulement sur une lettre née ici, avec
// `relais_porte` au journal. Une lettre accusée ici entre-temps se marque
// aussi : c'est `porte_vers` qui fera partir son accusé vers la copie de
// là-bas (R16). Rend le nombre de lettres marquées.
export function marquerPortees(db, mac, msgIds, { at = null } = {}) {
  const vers = exigerUnNomDeMac(mac, "the other Mac");
  if (!Array.isArray(msgIds)) throw paquetInvalide("the carried msg_ids must be an array");
  const heure = at || nowIso();
  const marquer = db.prepare(
    "UPDATE messages SET porte_at = ?, porte_vers = COALESCE(porte_vers, ?) WHERE msg_id = ? AND via IS NULL AND porte_at IS NULL"
  );
  return db.transaction(() => {
    let marquees = 0;
    for (const msgId of msgIds) {
      if (!texteNonBlanc(msgId)) continue;
      if (marquer.run(heure, vers, msgId).changes === 0) continue;
      recordEvent(db, msgId, ACTEUR, "relais_porte", { mac: vers });
      marquees += 1;
    }
    return marquees;
  })();
}

// ── LES REFUS RENDUS À L'ORIGINE (R29) ──────────────────────────────────────
//
// Un refus (R18) laisse la lettre en route sur son Mac d'origine ; sans retour,
// l'expéditeur n'y voyait qu'une lettre « à porter » pour toujours, et le refus
// ne vivait qu'au journal du bureau qui l'a fait. Le Mac d'origine écrit donc
// `relais_refus` `{ mac, raison }` sur SA lettre, `mac` étant le Mac qui l'a
// refusée :
//   · la tournée, pour ses lettres que l'autre Mac a refusées (`resume.refus` de
//     sa réponse), au pas 3, avec les autres marques ;
//   · `echanger`, pour ses lettres que le relais a refusées à l'import de la
//     tournée d'avant (`marquer.refusees`), avec les autres marques.
// Une fois par lettre et par raison : la lettre refusée se représente à chaque
// tournée, son refus aussi, et le journal ne double pas.

// La forme d'une liste de refus, `[{ msg_id, raison }]` (deux textes non
// blancs), vérifiée EN ENTIER avant la première écriture.
export function exigerDesRefus(refus, role = "refus") {
  if (!Array.isArray(refus)) throw paquetInvalide(`${role} must be an array of { msg_id, raison }`);
  refus.forEach((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r) || !texteNonBlanc(r.msg_id) || !texteNonBlanc(r.raison)) {
      throw paquetInvalide(`${role} ${i} must be { msg_id, raison } (two non-blank strings)`);
    }
  });
  return refus;
}

// Écrit `relais_refus` `{ mac, raison }` sur chaque lettre de `refus` qui est une
// lettre d'ICI (`via` nul), offerte à `mac` (`porte_vers`) et pas encore portée
// (`porte_at` nul) : un refus forgé, ou pour une lettre d'ailleurs, ne touche
// rien. Rend le nombre de refus écrits (0 quand tous l'étaient déjà).
export function noterLesRefus(db, mac, refus) {
  const par = exigerUnNomDeMac(mac, "the other Mac");
  exigerDesRefus(refus);
  const offerte = db.prepare(
    "SELECT 1 FROM messages WHERE msg_id = ? AND via IS NULL AND porte_vers = ? AND porte_at IS NULL"
  );
  return db.transaction(() => {
    let notes = 0;
    for (const { msg_id: msgId, raison } of refus) {
      if (!offerte.get(msgId, par) || dejaNote(db, msgId, "relais_refus", par, raison)) continue;
      recordEvent(db, msgId, ACTEUR, "relais_refus", { mac: par, raison });
      notes += 1;
    }
    return notes;
  })();
}

// Les évènements d'un paquet que `mac` a importé : chacun marque ce qu'il a
// rendu, et seulement ce qu'il a rendu (une remise ne cache jamais l'accusé
// qui viendra). Les deux sens : une lettre arrivée de `mac` (`remise` ou
// `accuse`), ou née ici et portée vers `mac` (`accuse`, R16). Une marque ne
// se pose que sur un fait qui existe ici (remise, accusée) : un évènement forgé
// ne peut pas taire un accusé à venir. Rend le nombre de marques posées.
export function marquerRendus(db, mac, evenements, { at = null } = {}) {
  const de = exigerUnNomDeMac(mac, "the other Mac");
  if (!Array.isArray(evenements)) throw paquetInvalide("the reported events must be an array");
  const heure = at || nowIso();
  const remise = db.prepare(`
    UPDATE messages SET remise_rendue_at = @at
    WHERE msg_id = @msg_id AND via = 'relais' AND mac_origine = @mac AND remise_rendue_at IS NULL
      AND delivered_at IS NOT NULL
  `);
  const accuse = db.prepare(`
    UPDATE messages SET accuse_rendu_at = @at
    WHERE msg_id = @msg_id AND accuse_rendu_at IS NULL AND acked_at IS NOT NULL
      AND ((via = 'relais' AND mac_origine = @mac) OR (via IS NULL AND porte_vers = @mac))
  `);
  return db.transaction(() => {
    let marques = 0;
    for (const evenement of evenements) {
      if (!evenement || !texteNonBlanc(evenement.msg_id)) continue;
      const marque = evenement.type === "remise" ? remise : evenement.type === "accuse" ? accuse : null;
      if (!marque) continue;
      marques += marque.run({ at: heure, msg_id: evenement.msg_id, mac: de }).changes;
    }
    return marques;
  })();
}
