// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE RETOUR À L'EXPÉDITEUR (1.1.0, Tâche 3).
//
// Le cas réel (20/11) : un modèle local a écrit deux lettres au nom NU d'une lignée qui n'existait
// que sous un nom long. Elles ont attendu sans être livrées, et personne ne le savait — pas même
// l'expéditeur. Elles venaient d'un greffon d'un autre harnais qui écrit DIRECTEMENT dans SQLite,
// sans passer par le serveur MCP : l'avis du `send` ne lui parvient jamais. Le retour se fait donc
// ICI, à la tournée du Facteur, qui lit le bureau — pour que TOUTES les sources en profitent.
//
// La règle : une lettre vers un nom que personne n'a JAMAIS porté (`nomJamaisPorte`, registry.js),
// que personne n'a relevée, et qui attend depuis `retourApresMs` (VALXOS_RETOUR_APRES_S, 900 s
// par défaut), revient à son expéditeur. Le retour est une lettre du système :
//   · expéditeur `facteur`, `msg_type: "status"`, priorité basse ;
//   · CALME (`sans_reveil = 1`) : ni socket, ni Facteur, ni filet du Stop — l'expéditeur la lit
//     au tour suivant (SessionStart, PostToolUse, `inbox`). « Priorité low » ne suffirait pas :
//     le Facteur porte une lettre `sans_reveil = 0`, quelle que soit sa priorité ;
//   · dans le fil de la lettre d'origine, en réponse à elle (`reponse_a`), avec son objet, la
//     raison et les noms vivants qui approchent (`suggestionsPourUnNom`).
//
// ⚠️ RIEN N'EST EFFACÉ, RIEN NE SE FERME. La lettre d'origine reste au bureau, non accusée : si
// quelqu'un prend ce nom demain, elle lui arrive. Elle est seulement MARQUÉE retournée — un
// événement `retournee` au journal des livraisons (`delivery_events`), comme les autres constats
// du Facteur (`sans_chaise_designee`, `alias_applique`) : aucune colonne neuve, aucune migration.
// La marque est aussi la garde : un retour par lettre, jamais un par tournée, et deux porteurs
// qui se croisent se départagent dans la transaction IMMÉDIATE (le verrou d'écriture de SQLite).
//
// Ce qui ne revient JAMAIS :
//   · une lettre vers un nom déjà porté (une fiche morte, retirée, une réexpédition, le carnet) :
//     son régime d'avant, inchangé ;
//   · une lettre déjà relevée par quelqu'un (`delivered_at`, `injected_at`), portée
//     (`carried_at`) ou accusée : elle n'est pas perdue ;
//   · une lettre de `facteur` lui-même : un retour n'a pas d'expéditeur à qui revenir, et un
//     retour vers un nom que personne ne porte ne fait pas de boucle ;
//   · une lettre À `facteur` (une réponse à un retour) : elle reste au bureau, et le retour
//     finit par « Automatic notice; no need to reply. ».
import { inscrireUneLettre, recordEvent } from "../lib/database.js";
import {
  listeLisible,
  nomJamaisPorte,
  resolveRecipient as resolveRecipientReel,
  suggestionsPourUnNom
} from "../lib/registry.js";

// Le nom du système sur l'enveloppe. Vérifié le 21/11 : aucune lignée ni fiche du produit ne
// s'appelle ainsi (le Facteur signe ses tentatives `facteur@<hôte>#<pid>`, jamais une lettre).
export const EXPEDITEUR_DU_RETOUR = "facteur";
export const EVENEMENT_RETOUR = "retournee";
export const MOTIF_DU_RETOUR = "destinataire-inconnu";
// Un balayage ne renvoie pas plus que ça : le reste attend le balayage suivant.
export const RETOURS_PAR_TOURNEE = 20;
// LA CADENCE DU BALAYAGE (vague finale, 21/11). Le démon tourne chaque seconde ; le balayage,
// lui, coûtait 7,3 ms par tournée à la tête (mesuré) pour un délai de quinze minutes. Il tourne
// donc au plus une fois par minute : un retour arrive au plus une minute après son délai.
export const BALAYAGE_CHAQUE_MS = 60_000;

// Le balayage est-il dû ? `memoire` est la mémoire du démon, un objet qui traverse ses
// tournées (`{ dernierBalayageMs }`, daemon.js) ; sans mémoire (le one-shot, une tournée
// isolée), il l'est toujours. Une horloge qui RECULE le rend dû aussi : sans quoi un saut d'une
// heure en arrière tairait les retours une heure (docs/FACTEUR.md admet les sauts d'horloge).
// Quand il est dû, la mémoire prend l'heure de ce balayage-ci.
export function leBalayageEstDu(memoire, maintenant, chaqueMs = BALAYAGE_CHAQUE_MS) {
  if (!memoire || typeof memoire !== "object") return true;
  const dernier = memoire.dernierBalayageMs;
  const du =
    typeof dernier !== "number" || !Number.isFinite(dernier) || maintenant < dernier || maintenant - dernier >= chaqueMs;
  if (du) memoire.dernierBalayageMs = maintenant;
  return du;
}

// La marque d'une lettre retournée, ou null. Ne lève jamais.
export function marqueDuRetour(db, msgId) {
  try {
    const ligne = db
      .prepare(`
        SELECT event_at, detail_json FROM delivery_events
        WHERE msg_id = ? AND event_type = ?
        ORDER BY id ASC LIMIT 1
      `)
      .get(String(msgId), EVENEMENT_RETOUR);
    if (!ligne) return null;
    let detail = {};
    try {
      detail = JSON.parse(ligne.detail_json || "{}") || {};
    } catch {
      /* un détail illisible ne retire pas la marque */
    }
    return { at: ligne.event_at, ...detail };
  } catch {
    return null;
  }
}

function pluriel(n, unite) {
  return `${n} ${unite}${n === 1 ? "" : "s"}`;
}

// Le délai réglé, tel qu'on l'a écrit (900 s → « 15 minutes », 90 s → « 90 seconds »).
function dureeLisible(ms) {
  const secondes = Math.round(Number(ms) / 1000);
  if (secondes >= 60 && secondes % 60 === 0) return pluriel(secondes / 60, "minute");
  return pluriel(secondes, "second");
}

// L'âge d'une lettre, arrondi vers le bas dans une unité qu'on lit d'un coup d'œil : les
// secondes jusqu'à deux minutes, les minutes jusqu'à deux heures, les heures jusqu'à deux
// jours, puis les jours. Arrondi vers le bas : la lettre a attendu AU MOINS ça.
function ageLisible(ms) {
  const secondes = Math.floor(ms / 1000);
  if (secondes < 120) return pluriel(secondes, "second");
  const minutes = Math.floor(secondes / 60);
  if (minutes < 120) return pluriel(minutes, "minute");
  const heures = Math.floor(minutes / 60);
  if (heures < 48) return pluriel(heures, "hour");
  return pluriel(Math.floor(heures / 24), "day");
}

// Combien de temps la lettre a attendu : son âge réel, lu dans `created_at` à l'heure de la
// tournée (vague finale, 21/11 : au premier passage sur un vrai bureau, des lettres de 1 à 90
// jours reviennent, et « It waited 15 minutes » aurait été faux pour chacune). Un âge qui ne se
// lit pas (heure illisible, pas d'heure de tournée, une horloge qui recule) dit « more than »
// le délai : c'est tout ce qu'on sait d'une lettre que le balayage a jugée due.
function attenteLisible(lettre, { apresMs, maintenant }) {
  const nee = Date.parse(String(lettre.created_at ?? ""));
  const age = Number(maintenant) - nee;
  if (Number.isFinite(age) && age >= 0) return ageLisible(age);
  return `more than ${dureeLisible(apresMs)}`;
}

// LE TEXTE DU RETOUR — en anglais (une surface publique), et sans aucun nom que la lettre ne
// porte pas elle-même : le destinataire écrit, l'objet, l'identifiant, les suggestions.
export function lettreDeRetour(lettre, { suggestions = [], apresMs, maintenant = null }) {
  const destinataire = String(lettre.recipient ?? "");
  const objet = lettre.subject ? String(lettre.subject) : "";
  const raison = suggestions.length > 0
    ? `no one has this name; did you mean ${listeLisible(suggestions)}?`
    : "no one has this name. No name in service is close to it.";
  const lignes = [
    `Your letter ${lettre.msg_id} to "${destinataire}"${objet ? ` (subject: "${objet}")` : ""} was not delivered.`,
    `Reason (${MOTIF_DU_RETOUR}): ${raison}`,
    `It waited ${attenteLisible(lettre, { apresMs, maintenant })} and no one took this name.`,
    "",
    "Nothing is deleted: the letter stays in the post office, marked returned, and it will still arrive if " +
      `someone registers under "${destinataire}". To reach someone else, send it again to the right address.`,
    "",
    "— the Facteur",
    // La dernière ligne : un retour n'attend pas de réponse (une réponse à `facteur` reste au
    // bureau, et le balayage ne la renvoie pas — voir `enAttenteDeRetour`).
    "Automatic notice; no need to reply."
  ];
  return {
    subject: objet ? `Returned to sender: ${objet}` : `Returned to sender: your letter to ${destinataire}`,
    body: lignes.join("\n")
  };
}

// Un retour, une transaction IMMÉDIATE : la marque se relit sous le verrou d'écriture, puis la
// lettre de retour et la marque s'écrivent ensemble — ou rien. Deux porteurs qui ont lu la même
// lettre avant que l'un des deux ne la retourne se départagent ICI : le second trouve la marque
// et rend null. La lettre elle-même se relit aussi sous le verrou : relevée, portée ou accusée
// depuis la lecture du balayage, elle n'est pas perdue et ne revient pas (vague finale, 21/11).
// Rend la lettre de retour, ou null.
export function retournerUneLettre(db, lettre, { suggestions = [], apresMs, porteur = null, maintenant = Date.now() }) {
  const retour = db.transaction(() => {
    const deja = db
      .prepare("SELECT 1 FROM delivery_events WHERE msg_id = ? AND event_type = ? LIMIT 1")
      .get(lettre.msg_id, EVENEMENT_RETOUR);
    if (deja) return null;
    const relue = db
      .prepare("SELECT carried_at, delivered_at, injected_at, acked_at FROM messages WHERE msg_id = ?")
      .get(lettre.msg_id);
    if (!relue || relue.carried_at || relue.delivered_at || relue.injected_at || relue.acked_at) return null;
    const { subject, body } = lettreDeRetour(lettre, { suggestions, apresMs, maintenant });
    const { row } = inscrireUneLettre(db, {
      sender: EXPEDITEUR_DU_RETOUR,
      recipient: lettre.sender,
      subject,
      body,
      thread_id: lettre.thread_id || null,
      priority: "low",
      msg_type: "status",
      reponse_a: lettre.msg_id,
      sans_reveil: true,
      source: "facteur",
      created_at: new Date(maintenant).toISOString()
    });
    recordEvent(db, lettre.msg_id, porteur, EVENEMENT_RETOUR, {
      retour_msg_id: row.msg_id,
      a: lettre.sender,
      motif: MOTIF_DU_RETOUR,
      suggestions,
      apres_ms: apresMs
    });
    return row;
  });
  return retour.immediate();
}

// LE BALAYAGE : les lettres qui attendent un nom que personne n'a jamais porté, depuis le délai.
// Il lit le bureau, pas la sélection de la tournée : une lettre ajournée, ou calme, que la
// tournée ne prend pas, revient aussi. Coût d'un balayage : UNE lecture des destinataires des
// lettres jamais relevées (l'index `idx_messages_carried`, et `idx_delivery_events_msg_type`
// pour la marque), deux lectures indexées par nom pour juger « jamais porté », et la résolution
// seulement pour ces noms-là. Le démon l'appelle au plus une fois par minute (`leBalayageEstDu`).
// Rend le nombre de retours.
export function retournerLesLettres(
  db,
  { maintenant, retourApresMs, porteur, journal = () => {}, resoudre = resolveRecipientReel, limite = RETOURS_PAR_TOURNEE } = {}
) {
  const delai = Number(retourApresMs);
  if (!Number.isFinite(delai) || delai <= 0) return 0;
  // Une lettre déjà retournée reste non accusée pour toujours (rien ne se ferme) : elle sort du
  // balayage ici, pour que son nom ne se rejuge pas à chaque tournée.
  // Une lettre ADRESSÉE à `facteur` (une réponse à un retour) n'en sort pas non plus : le nom du
  // système n'est le nom de personne, elle rebondirait chez son expéditeur (reproduit le 21/11).
  // Elle reste au bureau, comme toute lettre.
  const enAttenteDeRetour = `
    m.carried_at IS NULL AND m.acked_at IS NULL AND m.delivered_at IS NULL AND m.injected_at IS NULL
    AND m.sender <> @systeme AND trim(m.sender) <> ''
    AND m.recipient <> @systeme
    AND NOT EXISTS (
      SELECT 1 FROM delivery_events e WHERE e.msg_id = m.msg_id AND e.event_type = @evenement
    )
  `;
  const parametres = { systeme: EXPEDITEUR_DU_RETOUR, evenement: EVENEMENT_RETOUR };
  const destinataires = db
    .prepare(`SELECT DISTINCT m.recipient FROM messages m WHERE ${enAttenteDeRetour}`)
    .all(parametres)
    .map((ligne) => String(ligne.recipient));
  const lettresDe = db.prepare(`
    SELECT m.* FROM messages m
    WHERE m.recipient = @destinataire AND ${enAttenteDeRetour}
    ORDER BY m.seq ASC
  `);

  let retournees = 0;
  for (const destinataire of destinataires) {
    if (retournees >= limite) break;
    if (!nomJamaisPorte(db, destinataire)) continue;
    // La ceinture : la résolution de la tournée elle-même doit dire « personne ». Un alias qui
    // mène à une famille sans chaise n'en est pas un (`nomJamaisPorte` l'a déjà écarté).
    let resolution;
    try {
      resolution = resoudre(db, destinataire);
    } catch {
      continue;
    }
    if (resolution?.kind !== "unknown" || resolution.alias) continue;

    const dues = lettresDe
      .all({ ...parametres, destinataire })
      .filter((lettre) => {
        // L'heure de naissance écrite par la source (le guichet, ou un greffon) ; illisible,
        // la lettre ne revient pas — on ne renvoie pas sur une heure qu'on ne sait pas lire.
        const nee = Date.parse(String(lettre.created_at ?? ""));
        return Number.isFinite(nee) && maintenant - nee >= delai;
      });
    if (dues.length === 0) continue;
    const suggestions = suggestionsPourUnNom(db, destinataire);
    for (const lettre of dues) {
      if (retournees >= limite) break;
      const retour = retournerUneLettre(db, lettre, { suggestions, apresMs: delai, porteur, maintenant });
      if (!retour) continue;
      retournees += 1;
      // Jamais l'objet ni le corps au journal.
      journal({
        evenement: "facteur_retour_a_l_expediteur",
        msg_id: lettre.msg_id,
        retour_msg_id: retour.msg_id,
        destinataire,
        expediteur: lettre.sender,
        suggestions
      });
    }
  }
  return retournees;
}
