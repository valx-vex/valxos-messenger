// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE GUICHET — poster une lettre. La loi écrite UNE fois.
//
// Les quatre gestes d'un envoi (inscrire · résoudre · réveiller · avertir) ont
// vécu INLINE dans `send` et `broadcast` du serveur MCP, recopiés d'une surface
// à l'autre. Une troisième surface qui les recopierait perdrait au moins un des
// remèdes ci-dessous, et personne ne le verrait avant l'incident.
//
// ── POURQUOI CE FICHIER EST ÉCRIT COMME ÇA ──────────────────────────────────
//
// Six remèdes dorment dans quarante lignes de code. Leur histoire est ici, en
// bloc, pour que le code reste lisible d'un coup d'œil ; au-dessus de chaque
// ligne ne subsiste que la phrase qui la protège. Un lecteur pressé lit le
// code ; un lecteur qui veut toucher lit d'abord ceci.
//
// R2 — TOUT SE DÉRIVE DE LA LIGNE, JAMAIS DU `to` QU'ON VIENT DE TAPER.
//   Un rejeu (même msg_id) rend la ligne EXISTANTE. Dériver du `to` de CET
//   appel réveillerait la mauvaise porte tout en prétendant avoir livré à
//   `to`. Trois champs en dépendent : le réveil, l'avis, le destinataire
//   annoncé.
//
// C1 — LE SCAN DES MAISONS NE S'ENFERME PAS DANS LA LETTRE.
//   `send` en fait un par appel ; `broadcast` en PARTAGE un seul entre toutes
//   ses cibles (les maisons ne changent pas d'une cible à l'autre dans le MÊME
//   appel). D'où `deps.maisons` : fourni, il se réutilise ; absent, la lettre
//   se paie son propre scan plutôt que de partir sans avis.
//
// C2 — UNE SEULE RÉSOLUTION PAR LETTRE, LUE PAR LES DEUX CONSOMMATEURS.
//   `porteDeReveil` et `avisDAttente` en faisaient chacun une, avec le `await`
//   du réveil entre les deux (jusqu'à 500 ms). Le registre bougeait dans cet
//   écart et les deux champs d'une MÊME réponse divergeaient : 4 cas sur 12
//   lettres rejouées. Ils sont gelés sur le même instant. Cette résolution
//   reste PROPRE À CETTE LETTRE — jamais partagée entre deux destinataires
//   d'une diffusion, contrairement au scan.
//
// ④ — L'ANNONCE DU REJEU EST UNE LOI, PAS UNE MISE EN FORME DE SURFACE.
//   R2 fait gagner la ligne existante ; le corollaire, c'est que le posteur
//   DOIT s'entendre dire que son `to` a été écarté. Sans ça une surface répond
//   « sent:true » à quelqu'un dont la lettre est partie ailleurs. La phrase
//   était déjà recopiée deux fois ; la troisième surface aurait été la
//   première à l'oublier.
//
// ⑦ — UN REMÈDE QUI DÉPLACE UN FAIT DOIT DÉPLACER SA SOURCE.
//   ④ a déplacé l'ANNONCE ici sans déplacer le FAIT : le guichet comparait
//   `row.recipient !== entree.recipient`. Une devinette. Or `inscrireUneLettre`
//   accepte DEUX orthographes du destinataire ; un appelant qui passe
//   `{to, body, sender}` — la forme exacte du schéma d'entrée de l'outil MCP
//   `send` — laissait `entree.recipient` à `undefined`, et le guichet annonçait
//   un rejeu sur une lettre NEUVE, dans une base VIDE. Régression de ④, pas
//   trou préexistant : avant lui, chaque surface comparait au `to` qu'ELLE
//   avait reçu, toujours bon par construction.
//
// ⑧ — LE FAIT DU REJEU N'EST PAS LA DIVERGENCE DU DESTINATAIRE.
//   La comparaison lisait l'une pour l'autre. Deux `--msg-id` identiques vers
//   le MÊME nom avec deux corps différents : `sent:true` sec, et le corps que
//   le posteur venait de taper jeté sans un mot. C'est A8 qui ment.
//   D'où `ecarte`, MOTIF DISTINCT et non champ de `rejeu` : `rejeu` dit « cette
//   lettre existait déjà » (l'idempotence qui fonctionne, cas normal d'un
//   renvoi), `ecarte` dit « ce que tu viens de taper n'est parti nulle part »
//   (une perte). Les fondre ferait crier au loup à chaque renvoi honnête, et le
//   jour où ça compte plus personne ne lirait. `ecarte` porte la VALEUR jetée :
//   la réponse est le dernier endroit où le posteur peut la récupérer.
import { getMessageById, inscrireUneLettre, journaliserAlias } from "./database.js";
import { porteDeReveil, resolveRecipient } from "./registry.js";
import { pokeAgentSocket } from "./socket.js";
import { avisDAttente, scannerLesMaisons } from "../facteur/round.js";

// C1 — un scan raté ne retient JAMAIS une lettre : l'avis est un service rendu
// au posteur, pas une condition du départ.
export function scannerSansCasser(deps = {}) {
  const scanner = deps.scanner || scannerLesMaisons;
  try {
    return scanner();
  } catch {
    return { houses: [], parSession: new Map() };
  }
}

// C2 — même doctrine : les deux consommateurs savent s'abstenir sans
// résolution, donc une panne du registre coûte au pire un avis, jamais la lettre.
export function resoudreSansCasser(db, recipient, deps = {}) {
  const resoudre = deps.resoudre || resolveRecipient;
  try {
    return resoudre(db, recipient);
  } catch {
    return null;
  }
}

// POSTER UNE LETTRE.
//
// `entree` est ce qu'`inscrireUneLettre` attend (msg_id, sender, recipient OU
// to, body…) — les deux orthographes du destinataire, et c'est la base SEULE
// qui tranche entre elles (⑦).
//
// Rend `{ row, resolution, wake, attente, rejeu, ecarte }` : la ligne en base,
// LA résolution de cette lettre-là, le réveil direct, l'avis d'attente (nul
// quand la lettre est livrable — le silence des cas sains), l'annonce du rejeu
// (nulle sur une lettre neuve) et ce que le rejeu a écarté (nul quand rien de
// ce que le posteur a tapé n'a été perdu).
//
// `deps` : `maisons` un {houses, parSession} déjà scanné à réutiliser (C1) ·
// `scanner` de quoi en calculer un · `resoudre` la résolution du registre (le
// MÊME injecté partout, C2) · `reveiller` le coup frappé à la porte.
export async function posterUneLettre(db, entree, deps = {}) {
  const resoudre = deps.resoudre || resolveRecipient;
  const reveiller = deps.reveiller || pokeAgentSocket;

  // ⑦/⑧ — le guichet REÇOIT les trois faits, il n'en déduit aucun.
  const { row, neuve, demande, ecarte } = inscrireUneLettre(db, entree);

  // R2 — de la LIGNE, jamais du `to` de cet appel.
  const resolution = resoudreSansCasser(db, row.recipient, { resoudre });
  // L'alias appliqué se dit au journal, une fois par lettre (la base garde).
  journaliserAlias(db, row, resolution);

  // C1 — fourni, on réutilise ; absent, on paie son propre scan.
  const { houses, parSession } = deps.maisons || scannerSansCasser({ scanner: deps.scanner });

  // C2 — LA MÊME résolution pour le réveil et pour l'avis, gelée sur un instant.
  const wake = await reveiller(porteDeReveil(db, row.recipient, resolution), row.msg_id);
  const attente = avisDAttente(
    db,
    { recipient: row.recipient },
    { houses, parSession, resoudre, resolutionExistante: resolution }
  );

  // ④/⑦ — le FAIT du rejeu vient de la base, pas d'une comparaison d'ici.
  const rejeu = neuve ? null : { motif: "msg_id-deja-connu", demande };

  return { row, resolution, wake, attente, rejeu, ecarte };
}

// ── LA CLEF D'UN TIERS (garde n°2 de la porte web, 22/08 ; F12, 28/09) ──────
//
// `msg_id` est choisi par le posteur, et `posterUneLettre` rend LA LIGNE
// EXISTANTE quand la clef est prise (R2). Poster sous la clef d'une lettre
// entre deux TIERS rendait donc le destinataire et le seq d'autrui, un coup de
// sonnette chez lui, et le texte tapé nulle part. La porte web l'avait fermé
// pour elle seule ; le guichet MCP et `valxos-send` rendaient encore la ligne
// d'autrui (vérifié le 28/09, doute de la passe adverse). La règle vit ICI,
// une fois, pour les trois portes : ON NE DÉPOSE QUE SOUS UNE CLEF QUI EST À
// SOI (`estAMoi(row)`). Une clef prise par le courrier d'un tiers est ÉCARTÉE
// et la lettre part sous une clef que le guichet génère (A8 : un doublon
// plutôt qu'une lettre perdue). `clefEcartee` le dit ; c'est un bit
// d'existence, le prix documenté du contrat (voir src/web/serveur.js).
//
// Deux essais, pas plus : ① la clef avant la lettre (on n'écrit rien sous une
// clef d'autrui — `posterUneLettre` RÉVEILLE le destinataire de la ligne
// trouvée) ; ② après, parce que ① n'est qu'une photo (une autre surface a pu
// prendre la clef entre les deux). Au-delà, `clef_indisponible`.
export async function posterSousUneClefASoi(db, entree, { estAMoi, chercher = getMessageById, poster = posterUneLettre } = {}) {
  let clef = String(entree.msg_id ?? "").trim() || undefined;
  let clefEcartee = null;
  for (let essai = 1; essai <= 2; essai += 1) {
    const dejaLa = clef ? chercher(db, clef) : null;
    if (dejaLa && !estAMoi(dejaLa)) {
      clefEcartee = clef;
      clef = undefined;
    }
    const resultat = await poster(db, { ...entree, msg_id: clef });
    if (estAMoi(resultat.row)) return { ...resultat, clefEcartee };
    clefEcartee = clef ?? clefEcartee;
    clef = undefined;
  }
  const erreur = new Error("the letter could not be posted under a key that belongs to its sender");
  erreur.code = "clef_indisponible";
  throw erreur;
}

// Le courrier d'un posteur : ce qu'il a envoyé, ou reçu, sous CE nom.
export function estLeCourrierDe(nom) {
  return (row) => Boolean(row) && (row.sender === nom || row.recipient === nom);
}
