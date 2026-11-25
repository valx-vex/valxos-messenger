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
import { getMessageById, inscrireUneLettre, journaliserAlias, lettresDUnEnvoi, normalizePriority, recordEvent } from "./database.js";
import { SEPARATEUR_INSTANCE, estUneChaiseCourte, getInstance, porteDeReveil, resolveRecipient } from "./registry.js";
import { pokeAgentSocket } from "./socket.js";
import { avisDAttente, scannerLesMaisons } from "../facteur/round.js";
import crypto from "node:crypto";
import { enclosQuiTiennent, estMembre, formesDeLExpediteur, membresDeTable, obtenirTable, validerNomDeTable } from "./tables.js";

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

// LA CHAISE COURTE (1.1.0, Tâche 8). `lignée#<8 hexadécimaux ou plus>` se résout au registre
// vers UNE chaise (`abrege` sur la résolution) ; la lettre s'écrit alors sous l'adresse ENTIÈRE
// de cette chaise, parce que c'est sous elle que ses hooks (`adressesDuRepli`), son `inbox` et
// son moniteur relèvent — gardée sous la forme courte, personne ne la lirait. Ambiguë (deux
// candidates) ou inconnue : rien ne change, l'adresse reste telle qu'écrite, et l'avis d'attente
// le dit (`chaise-ambigue`, `destinataire-inconnu`). Pure sur l'entrée : une entrée NEUVE est
// rendue, l'objet du posteur n'est pas touché ; une seule orthographe du destinataire subsiste
// (`recipient`), pour que la base n'ait pas à trancher entre deux (⑦). C2 : `deps.resoudre` est
// la résolution qu'on écoute, et une résolution qui lève ne retient jamais la lettre.
export function canoniserLaChaiseCourte(db, entree, deps = {}) {
  const ecrit = String(entree?.recipient || entree?.to || "").trim();
  if (!estUneChaiseCourte(ecrit)) return { entree, chaiseCourte: null };
  const resolution = resoudreSansCasser(db, ecrit, deps);
  if (!resolution?.abrege || resolution.kind !== "instance" || resolution.targets.length !== 1) {
    return { entree, chaiseCourte: null };
  }
  const chaise = resolution.targets[0].id;
  if (!chaise || chaise === ecrit) return { entree, chaiseCourte: null };
  const canonisee = { ...entree, recipient: chaise };
  delete canonisee.to;
  return { entree: canonisee, chaiseCourte: { demande: ecrit, chaise } };
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
// MÊME injecté partout, C2) · `reveiller` le coup frappé à la porte ·
// `porteParLeRelais` (`true` seulement) la clef de `via` et `mac_origine`,
// que seul l'import d'un paquet tient (relais/paquet.js).
export async function posterUneLettre(db, entree, deps = {}) {
  const resoudre = deps.resoudre || resolveRecipient;
  const reveiller = deps.reveiller || pokeAgentSocket;

  // L'ENCLOS — AVANT la moindre écriture (point de revue 6). Le refus est une
  // erreur typée : une surface la rend `{ refus: "hors-enclos", … }`, jamais
  // une exception au client ; ici on LÈVE, parce qu'un refus qu'on pourrait
  // confondre avec un envoi est un envoi perdu (même doctrine qu'AccuseRefuse).
  // `sender`/`from`, `recipient`/`to` : les deux orthographes, comme la base (⑦).
  // LA CHAISE COURTE (1.1.0, Tâche 8) se canonise AVANT l'enclos et l'écriture, par UNE résolution
  // (`canoniserLaChaiseCourte`, pure : rien ne s'écrit avant l'enclos). L'enclos accepte la lettre
  // si la forme TAPÉE ou la forme CANONISÉE est membre active : un membre inscrit sous l'adresse
  // entière se joint par sa forme courte unique, un membre inscrit sous sa forme courte reste
  // joignable par elle. La forme vérifiée est celle qui s'écrit ; le refus nomme la forme tapée.
  const expediteur = entree.sender || entree.from;
  // LES MARQUES DU RELAIS (schéma 8) n'appartiennent qu'au relais : `via` et
  // `mac_origine` disent « cette lettre vient de l'autre Mac », et une marque
  // qu'un posteur pourrait poser lui-même mentirait au lecteur (`Via:` dans
  // l'en-tête) et fermerait la porte du retour (une lettre `via` ne repart
  // jamais). Seul l'import d'un paquet passe `porteParLeRelais: true` — le
  // booléen strict, jamais une valeur qui y ressemble. Avant toute écriture.
  // Un champ nul est un champ que la surface ne dit pas : il ne refuse rien.
  const marqueDuRelais = (valeur) => valeur !== undefined && valeur !== null;
  if ((marqueDuRelais(entree.via) || marqueDuRelais(entree.mac_origine)) && deps.porteParLeRelais !== true) {
    throw erreurTypee(
      "via-reservee-au-relais",
      "via and mac_origine are set only by the relay when it imports a packet from the other Mac; nothing was written"
    );
  }
  // B10 (relecture du guichet) : AUCUNE LETTRE SANS DESTINATAIRE. Sans
  // `recipient` ni `to`, la base levait une erreur sans code ; un destinataire
  // BLANC s'écrivait tel quel. Le guichet refuse les deux, avant l'enclos et
  // avant toute écriture — la même orthographe que la base lira (⑦).
  if (!String(entree.recipient || entree.to || "").trim()) {
    throw erreurTypee("adresse-invalide", "a letter needs a recipient: recipient (or to) is missing or blank", {
      motif_refus: "a letter needs a recipient: recipient (or to) is missing or blank"
    });
  }
  const { entree: aEcrire, chaiseCourte } = canoniserLaChaiseCourte(db, entree, { resoudre });
  const tapee = entree.recipient || entree.to;
  const refusEnclos = verifierEnclos(
    db,
    expediteur,
    [chaiseCourte ? [tapee, chaiseCourte.chaise] : tapee],
    { horsEnclos: entree.hors_enclos === true, chaiseId: entree.sender_chaise || null }
  );
  if (refusEnclos) throw erreurHorsEnclos(refusEnclos, expediteur);

  // ⑦/⑧ — le guichet REÇOIT les trois faits, il n'en déduit aucun.
  const { row, neuve, demande, ecarte } = inscrireUneLettre(db, aEcrire);
  // La forme tapée reste au journal — une fois, sur la lettre neuve (Camp B : rien ne s'efface,
  // et l'expéditeur peut relire ce qu'il a écrit).
  if (neuve && chaiseCourte) recordEvent(db, row.msg_id, row.sender, "chaise_courte_appliquee", chaiseCourte);

  // R2 — de la LIGNE, jamais du `to` de cet appel.
  const resolution = resoudreSansCasser(db, row.recipient, { resoudre });
  // L'alias appliqué se dit au journal, une fois par lettre (la base garde).
  journaliserAlias(db, row, resolution);

  // C1 — fourni, on réutilise ; absent, on paie son propre scan.
  const { houses, parSession } = deps.maisons || scannerSansCasser({ scanner: deps.scanner });

  // C2 — LA MÊME résolution pour le réveil et pour l'avis, gelée sur un instant.
  // LA LETTRE CALME (1.1.0) : décidée au guichet (`deciderLeReveil`), écrite
  // dans `sans_reveil`, et lue sur LA LIGNE — R2 : sur un rejeu, c'est la lettre
  // en base qui dit si elle réveille, jamais ce que cet appel vient de taper.
  // On ne frappe à aucune porte ; le repli (`getPendingForContext`), `inbox` et
  // le moniteur la servent au tour suivant. Rien ne se perd (A9).
  const calme = Number(row.sans_reveil) === 1;
  const wake = calme
    ? { ok: false, skipped: "sans-reveil" }
    : await reveiller(porteDeReveil(db, row.recipient, resolution), row.msg_id);
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

// ── LE RÉVEIL D'UNE LETTRE (1.1.0, spec A §4) ───────────────────────────────
// Décidé ICI, une fois, et écrit dans `sans_reveil` : aucun porteur ne le
// recalcule (le Facteur, le filet du Stop et le moniteur LISENT la colonne).
// Les règles, dans l'ordre où elles se lisent — l'ordre EST la loi :
//   1. `critical`/`high` → réveil, toujours (point de revue 5) ;
//   2. `low` → jamais (c'était déjà la règle du filet du Stop ; le Facteur 1.0.0, lui,
//      portait les LOW — pour une lettre de table, il ne la porte plus non plus) ;
//   3. une mention (`reveiller: [...]`) → réveil, quelle que soit la table ;
//   4. une réaction (`reponse_a`) dans une table `direct` → calme ;
//   5. sinon le réglage du membre, à défaut celui de la table :
//      `prochain-tour` → calme.
// Pure : ni base, ni horloge — un tableau de test la joue telle quelle. La
// priorité se normalise comme en base (`normalizePriority`) : une priorité
// malformée ne se fait jamais plus discrète qu'une vraie `low`.
export function deciderLeReveil({
  priority,
  tableReveil,
  membreReveil = null,
  reaction = false,
  modeTable = "normal",
  mentionne = false
}) {
  const p = normalizePriority(priority);
  if (p === "critical" || p === "high") return { sansReveil: false, motif: "priorite-haute" };
  if (p === "low") return { sansReveil: true, motif: "priorite-basse" };
  if (mentionne) return { sansReveil: false, motif: "mention" };
  if (reaction && modeTable === "direct") return { sansReveil: true, motif: "reaction-directe" };
  const regle = membreReveil ?? tableReveil;
  return { sansReveil: regle === "prochain-tour", motif: membreReveil ? "membre" : "table" };
}

// ── LES FORMES DE L'EXPÉDITEUR ──────────────────────────────────────────────
// Elles vivent au carnet (tables.js, `formesDeLExpediteur`) depuis S9 : le
// carnet en a besoin pour refuser deux enclos qui tiendraient un même
// expéditeur. Le guichet les relit de là, et les réexporte pour ses surfaces.
export { formesDeLExpediteur };

// Un refus finit devant un inconnu, par le MCP, la CLI ou la porte web : il ne
// recopie de l'entrée que ECHO_MAX caractères (des points de code, pour ne pas
// couper un emoji), les caractères de contrôle — retours à la ligne compris —
// remplacés par une espace. Même règle que l'`echo` du carnet (tables.js).
// Exportée pour le serveur MCP : ses refus recopient l'entrée sous CETTE règle,
// jamais sous une troisième copie (revue de la Tâche 3, mineur 7).
const ECHO_MAX = 64;
export function borne(valeur) {
  const points = [...String(valeur ?? "")];
  const court = points.slice(0, ECHO_MAX).join("").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  return points.length > ECHO_MAX ? `${court}…` : court;
}

// Une erreur à CODE : les surfaces lisent `code` et le rendent `{ refus }`,
// jamais une exception au client. La phrase est pour l'humain, en anglais.
function erreurTypee(code, message, champs = {}) {
  const erreur = new Error(message);
  erreur.code = code;
  Object.assign(erreur, champs);
  return erreur;
}

// ── LE PRÉFIXE `table:` (1.1.0) ─────────────────────────────────────────────
// Il se lit sans casse, ici comme au carnet (`validerAdresse`) : `TABLE:atelier`
// est une table, jamais un pair. Une fois, pour l'enclos d'ici, le serveur MCP
// et `valxos-send` : `table:<nom>` → le nom tel qu'écrit après le préfixe (le
// carnet le normalise) ; toute autre adresse → null (un pair, une chaise…).
const PREFIXE_TABLE = /^table:/i;
export function nomDeTableDe(adresse) {
  const propre = String(adresse ?? "").trim();
  return PREFIXE_TABLE.test(propre) ? propre.replace(PREFIXE_TABLE, "").trim() : null;
}

// `table:<nom>` désigne-t-elle cette table ? Le nom se lit comme au carnet
// (espaces autour, casse) : `table:Atelier` est `table:atelier`.
function designeLaTable(adresse, nomTable) {
  const nom = nomDeTableDe(adresse);
  return nom !== null && nom.toLowerCase() === nomTable;
}

// ── L'ENCLOS (1.1.0, spec A §4, décision A1) ────────────────────────────────
// Un expéditeur sous enclos n'écrit qu'aux membres ACTIFS de la table FERMÉE
// nommée par son enclos, sous la forme écrite dans la table, ou à l'adresse
// `table:<cet enclos>`. Tout autre destinataire fait refuser L'ENVOI ENTIER,
// avant la moindre écriture (point de revue 6). L'enclos se lit sous toutes
// les formes de l'expéditeur : posé sur la lignée `carol` par la CLI, il vaut
// pour la chaise `carol#s-1` qui poste. `horsEnclos` est la clef que
// l'expéditeur garde en main (`hors_enclos: true` dans l'appel) : le guichet
// laisse passer, et la lettre le dit — l'enclos ne se contourne jamais en
// silence. Rend `null` quand rien n'est à redire, sinon le refus à trois
// champs, tel que les surfaces le rendent ; chaque destinataire refusé y est
// borné (`borne`) : c'est de l'entrée recopiée, elle finit devant un inconnu.
// La LISTE l'est aussi : LISTE_MAX refusés au plus (les premiers, dans l'ordre
// donné), et `autres` compte le reste quand il y en a.
// Un destinataire peut venir avec ses formes ÉQUIVALENTES (un tableau : la forme
// tapée d'abord, puis l'adresse entière qu'une chaise courte désigne — Tâche 8) :
// il passe si l'une d'elles est membre active, et le refus nomme la première.
// S9 (seconde passe adverse) : TOUS les enclos actifs qui tiennent l'expéditeur
// sont lus (`enclosQuiTiennent`), jamais le premier trouvé. S'ils ne visent pas
// tous la même table — deux formes de lui enfermées ailleurs, un bureau d'avant
// ce correctif —, la lettre est refusée (`enclos-conflit`, les tables nommées)
// tant que l'opérateur n'en a pas levé un ; `hors_enclos: true` ouvre les deux,
// comme il ouvre un seul.
const LISTE_MAX = 20;
export function verifierEnclos(db, sender, destinataires, { horsEnclos = false, chaiseId = null } = {}) {
  if (horsEnclos === true || !destinataires || destinataires.length === 0) return null;
  const tenants = enclosQuiTiennent(db, sender, { chaiseId });
  if (tenants.length === 0) return null;
  const tables = [...new Set(tenants.map((e) => e.nom_table))].sort();
  if (tables.length > 1) {
    return {
      refus: "enclos-conflit",
      tables,
      enclos_poses: tenants.slice(0, LISTE_MAX).map((e) => ({ expediteur: borne(e.expediteur), table: e.nom_table }))
    };
  }
  const enclos = tenants[0];
  const refuses = [];
  let autres = 0;
  for (const destinataire of destinataires || []) {
    const formes = (Array.isArray(destinataire) ? destinataire : [destinataire])
      .map((forme) => String(forme || "").trim())
      .filter(Boolean);
    if (formes.length === 0 || formes.some((forme) => designeLaTable(forme, enclos.nom_table))) continue;
    if (estMembre(db, enclos.nom_table, formes)) continue;
    if (refuses.length < LISTE_MAX) refuses.push(borne(formes[0]));
    else autres += 1;
  }
  if (refuses.length === 0) return null;
  return {
    refus: "hors-enclos",
    enclos: enclos.nom_table,
    destinataires_refuses: refuses,
    ...(autres > 0 ? { autres } : {})
  };
}

// Le refus de l'enclos, en erreur typée : `code` pour les surfaces, les deux
// champs du refus à côté, une phrase pour l'humain. Les destinataires arrivent
// déjà bornés de `verifierEnclos` ; l'expéditeur se borne ici. Un conflit
// d'enclos (S9) garde son code et ses deux champs (`tables`, `enclos_poses`).
function erreurHorsEnclos(refus, sender) {
  if (refus.refus === "enclos-conflit") {
    return erreurTypee(
      "enclos-conflit",
      `sender "${borne(sender)}" is enclosed in more than one table (${refus.tables.join(", ")}): no letter goes out until the operator ` +
        "lifts one of these enclosures (valxos-table enclos --retirer <sender>). Pass hors_enclos: true to step outside deliberately.",
      { tables: refus.tables, enclos_poses: refus.enclos_poses }
    );
  }
  return erreurTypee(
    "hors-enclos",
    `sender "${borne(sender)}" is enclosed in table "${refus.enclos}": every recipient must be an active member of that table ` +
      `(or the address table:${refus.enclos}); refused: ${refus.destinataires_refuses.join(", ")}` +
      `${refus.autres ? ` and ${refus.autres} more` : ""}. ` +
      "Pass hors_enclos: true to step outside the enclosure deliberately.",
    {
      enclos: refus.enclos,
      destinataires_refuses: refus.destinataires_refuses,
      ...(refus.autres ? { autres: refus.autres } : {})
    }
  );
}

// ⑧ pour une lettre de table : le fil par défaut est dérivé par le guichet (un
// `envoi_id` neuf à chaque appel), il ne s'écarte que si le posteur l'a tapé.
// Rend `null` quand il ne reste rien d'écarté.
function ecarteDuPosteur(ecarte, { filTape }) {
  if (!ecarte) return null;
  const reste = { ...ecarte };
  if (!filTape) delete reste.thread_id;
  return Object.keys(reste).length > 0 ? reste : null;
}

// UN ENVOI QUI CASSE EN CHEMIN DIT CE QUI EST PARTI. Les lettres d'avant sont
// écrites et leurs portes frappées : rendre l'erreur nue ferait dire à une
// surface « refusé, rien d'écrit », ce qui est faux, et un renvoi sans clef
// doublerait tout. L'erreur garde le `code` d'origine (et ses champs : un
// `hors-enclos` de course garde `enclos` et `destinataires_refuses`), et porte
// `adresse` (le membre où l'envoi a cassé), `envoi_id`, `table` et
// `lettres_ecrites` : les lettres déjà posées, telles que `lettres` les aurait
// rendues. La lettre du membre fautif a pu NAÎTRE avant de casser (la panne
// vient après l'inscription : le réveil, l'avis) : la base le dit, pas une
// supposition — elle entre alors dans `lettres_ecrites` avec `interrompue:
// true` et `wake: null` (on ne sait pas si sa porte a été frappée).
// B14 (relecture du guichet) : la lettre née se cherche sous les formes que la
// lettre a pu ÉCRIRE (`adresses` : l'adresse inscrite, et la forme entière
// d'une chaise courte — `posterUneLettre` écrit celle-ci) ; et une panne SANS
// code devient `envoi-interrompu` (la panne d'origine reste dans `cause`) :
// une surface lit `code`, jamais une erreur sans nom.
const CODE_ENVOI_INTERROMPU = "envoi-interrompu";
function erreurEnvoiInterrompu(db, erreur, { nomTable, envoiId, adresse, adresses = [adresse], lettres, motif }) {
  const ecrites = [...lettres];
  try {
    const connues = new Set(lettres.map((lettre) => lettre.row.msg_id));
    const nee = lettresDUnEnvoi(db, envoiId).find((row) => adresses.includes(row.recipient) && !connues.has(row.msg_id));
    if (nee) {
      ecrites.push({
        to: adresse,
        row: nee,
        wake: null,
        attente: null,
        sans_reveil: Number(nee.sans_reveil) === 1,
        motif_reveil: motif,
        interrompue: true
      });
    }
  } catch {
    // La base ne répond plus : on rend ce qu'on sait, sans masquer la panne.
  }
  const origine = erreur instanceof Error ? erreur.message : String(erreur);
  const code = erreur?.code ?? CODE_ENVOI_INTERROMPU;
  return erreurTypee(
    code,
    `the send to table "${nomTable}" stopped at member "${borne(adresse)}" after ${ecrites.length} letter(s) were written: ${origine}`,
    {
      ...(erreur && typeof erreur === "object" ? erreur : {}),
      code,
      adresse,
      envoi_id: envoiId,
      table: nomTable,
      lettres_ecrites: ecrites,
      cause: erreur
    }
  );
}

// Le code de la panne qui a arrêté un envoi, tel qu'ELLE le portait (B14) — la
// `cause` qu'une surface rend à côté de `refus: "envoi-interrompu"` —, ou null
// quand elle n'en avait pas : aucune surface n'invente une cause.
export function codeDeLaCause(erreur) {
  const origine = erreur?.cause && typeof erreur.cause === "object" ? erreur.cause : erreur;
  const code = origine?.code;
  return code === undefined || code === null || code === "" || code === CODE_ENVOI_INTERROMPU ? null : String(code);
}

// ── LA FORME RENDUE AU POSTEUR (1.1.0) : une fois, pour le MCP et la CLI ────
// Ce que `posterAUneTable` rend (ou ce que son erreur porte), tel qu'un posteur
// le lit — l'outil MCP `send`/`reply` et `valxos-send` rendent la MÊME forme,
// jamais deux copies qui divergeraient. Pures : aucune base, aucune horloge.

// Une lettre de table telle que le posteur la voit : la clef, le seq, le réveil,
// l'attente — jamais la ligne entière (le corps, c'est lui qui l'a écrit).
// R2 : `to` est le destinataire de LA LIGNE (un rejeu sous une clef déjà prise
// vers ailleurs le fait diverger de l'adresse du membre, `rejeu.demande` le
// dit). `rejeu`, `ecarte` et `interrompue` passent tels quels, `clef_ecartee`
// sous la forme du `send` ordinaire (`{ demandee, motif: "clef-deja-prise" }`) ;
// tous absents quand le guichet ne les pose pas — le silence des cas sains. Une
// lettre REJOUÉE appartient à l'envoi qui l'a fait naître : elle porte alors
// son propre `envoi_id` (celui de la ligne), que `envoi_status` connaît —
// l'`envoi_id` de cet appel-ci ne lie aucune ligne qu'il n'a pas écrite.
export function lettreDeTableRendue(lettre, envoiId = null) {
  const envoiDeLaLigne = lettre.row?.envoi_id ?? null;
  return {
    to: lettre.row?.recipient ?? lettre.to,
    msg_id: lettre.row?.msg_id ?? null,
    seq: lettre.row?.seq ?? null,
    wake: lettre.wake ?? null,
    ...(lettre.attente ? { attente: lettre.attente } : {}),
    sans_reveil: lettre.sans_reveil,
    motif_reveil: lettre.motif_reveil,
    ...(lettre.rejeu ? { rejeu: lettre.rejeu } : {}),
    ...(lettre.ecarte ? { ecarte: lettre.ecarte } : {}),
    ...(lettre.clef_ecartee ? { clef_ecartee: { demandee: lettre.clef_ecartee, motif: "clef-deja-prise" } } : {}),
    ...(lettre.interrompue ? { interrompue: true } : {}),
    ...(envoiDeLaLigne && envoiDeLaLigne !== envoiId ? { envoi_id: envoiDeLaLigne } : {})
  };
}

// UN ENVOI DE TABLE QUI CASSE EN CHEMIN DIT CE QUI EST PARTI (ruling de la
// Tâche 2). L'erreur du guichet porte `lettres_ecrites` (la lettre du membre
// fautif comprise, `interrompue: true`, quand elle a eu le temps de naître),
// `envoi_id`, `table` et `adresse` : la réponse les rend tous, et sa phrase dit
// « N lettres parties, puis l'erreur » — jamais « rien d'écrit » à tort. Une
// liste VIDE ne dit rien (null) : rien n'est parti, le refus (ou la panne)
// parle seul. L'adresse est de l'entrée recopiée : bornée.
export function interruptionDEnvoi(erreur) {
  if (!Array.isArray(erreur?.lettres_ecrites) || erreur.lettres_ecrites.length === 0) return null;
  return {
    interrompu: true,
    envoi_id: erreur.envoi_id ?? null,
    table: erreur.table ?? null,
    adresse: erreur.adresse === null || erreur.adresse === undefined ? null : borne(erreur.adresse),
    lettres_ecrites: erreur.lettres_ecrites.map((lettre) => lettreDeTableRendue(lettre, erreur.envoi_id ?? null)),
    motif: erreur.message
  };
}

// ── POSTER À UNE TABLE (1.1.0, spec A §2 et §4) ─────────────────────────────
// Une table est un carnet d'adresses, pas une boîte : `table:<nom>` devient
// UNE lettre par membre actif, chacune avec son destinataire, son accusé, sa
// résolution et son avis — exactement `broadcast` — et toutes liées par
// `envoi_id`. Une table ne garde aucun courrier (Camp B : retirer une table
// ne fait disparaître aucune lettre). Ce qui se décide ICI, une fois pour
// tout l'envoi :
//   · qui reçoit : les membres actifs, moins les formes de l'expéditeur
//     (`formesDeLExpediteur`, point de revue 3) ; un membre inconnu du
//     registre reçoit une lettre qui attend (`destinataire-inconnu`), comme
//     aujourd'hui — et, si personne n'a jamais porté ce nom, le Facteur la
//     renvoie à l'expéditeur après le délai de retour (src/facteur/retour.js) ;
//   · le fil : `thread_id` donné, sinon l'`envoi_id` du premier envoi ;
//   · la copie : `sans_copie = 1` sur une table fermée — personne d'autre ne
//     la voit, même en attendant une désignation (point de revue 2) ;
//   · l'enclos : vérifié sur TOUS les destinataires avant la première
//     écriture (point de revue 6) ; `posterUneLettre` le revérifie par lettre
//     sur les mêmes faits — c'est la même fonction, pas une seconde loi ;
//   · le scan des maisons : UN pour tout l'envoi (C1), tendu à chaque lettre ;
//     la résolution, elle, reste celle de CHAQUE lettre (C2, `posterUneLettre`) ;
//   · le réveil : par membre (`deciderLeReveil`), écrit dans la lettre ;
//   · une panne au milieu de l'envoi : l'erreur dit ce qui est déjà parti
//     (`erreurEnvoiInterrompu` : `adresse`, `envoi_id`, `lettres_ecrites`).
// `msg_id` donné (nettoyé) devient `<msg_id>#<adresse>` par membre : rejouer
// l'envoi rejoue chaque lettre (R2, idempotence PAR MEMBRE) et le posteur
// l'apprend lettre par lettre (`rejeu`) ; `row.envoi_id` dit alors à quel envoi
// la lettre appartient vraiment — jamais `envoi_id` de ce rappel. Même loi
// pour le réveil annoncé (`sans_reveil` lu sur la ligne, `motif_reveil:
// "rejeu"`) et pour le destinataire : `to` est l'adresse du membre telle que la
// table la liste, la lettre est partie à `row.recipient` — une surface annonce
// celui-ci (une clef déjà prise vers ailleurs le fait diverger, `rejeu.demande`).
// F12 vaut ici comme aux trois autres portes : chaque lettre passe par
// `posterSousUneClefASoi`, et « à soi » se juge sur TOUTES les formes de
// l'expéditeur (le courrier qu'il a envoyé ou reçu sous l'une d'elles). Une
// clef tenue par la lettre d'un tiers est écartée, la lettre part sous une clef
// générée, et `clef_ecartee` le dit sur CETTE lettre (absent quand rien n'est
// écarté — le silence des cas sains).
// ⑧ vaut aussi : sur un rejeu, `ecarte` rend par lettre ce que le posteur a
// TAPÉ et qui n'est parti nulle part. La priorité part donc BRUTE vers la base
// (qui la normalise et sait si elle a été tapée), et le fil par défaut — un
// `envoi_id` neuf que personne n'a tapé — ne s'écarte jamais.
// Le nom se valide comme au carnet (`validerNomDeTable`, trim + minuscules) :
// un nom qui ne peut pas exister lève `nom-de-table-invalide`, un nom bien formé
// sans table lève `table-inconnue` ; puis `pas-membre`, puis `hors-enclos` —
// tous avant la moindre écriture. `table-inconnue` et `pas-membre` portent le
// nom normalisé (`table`), et ce qu'ils recopient de l'entrée est borné.
// m6 (re-revue du round FINAL) : `reveiller` se borne — 50 mentions de 200
// caractères (points de code) au plus. Chaque mention coûte une résolution ;
// au-delà, l'envoi entier est refusé avant toute lettre (`parametre-invalide`).
export const MENTIONS_MAX = 50;
export const MENTION_LONGUEUR_MAX = 200;
function verifierLesMentions(reveiller) {
  const liste = [reveiller ?? []].flat();
  if (liste.length <= MENTIONS_MAX && liste.every((mention) => [...String(mention ?? "")].length <= MENTION_LONGUEUR_MAX)) return;
  throw erreurTypee(
    "parametre-invalide",
    `reveiller takes at most ${MENTIONS_MAX} names of at most ${MENTION_LONGUEUR_MAX} characters each; nothing was written`,
    { parametre: "reveiller" }
  );
}

export async function posterAUneTable(db, entree, deps = {}) {
  verifierLesMentions(entree.reveiller);
  const nom = validerNomDeTable(entree.table);
  const table = obtenirTable(db, nom);
  if (!table) throw erreurTypee("table-inconnue", `table "${nom}" is unknown to this office`, { table: nom });

  const sender = entree.sender || entree.from;
  const chaiseId = entree.sender_chaise || null;
  const formes = formesDeLExpediteur(db, sender, { chaiseId });
  const membres = membresDeTable(db, table.nom);
  if (!membres.some((m) => formes.includes(m.adresse))) {
    throw erreurTypee(
      "pas-membre",
      `"${borne(sender)}" is not a member of table "${table.nom}" under any of its forms`,
      { table: table.nom }
    );
  }
  const destinataires = membres.filter((m) => !formes.includes(m.adresse));
  // LA FORME ENTIÈRE D'UN MEMBRE INSCRIT EN CHAISE COURTE (B7, B9) : la même
  // résolution que `posterUneLettre` (`canoniserLaChaiseCourte`), une fois par
  // membre, pour que l'enclos et la mention le lisent comme la lettre l'écrira.
  const resoudre = deps.resoudre || resolveRecipient;
  const entiere = new Map(destinataires.map((m) => [
    m.adresse,
    canoniserLaChaiseCourte(db, { recipient: m.adresse }, { resoudre }).chaiseCourte?.chaise ?? null
  ]));
  const formesDuMembre = (adresse) => [adresse, entiere.get(adresse)].filter(Boolean);

  // L'enclos : l'envoi ENTIER, avant la moindre écriture — chaque membre sous
  // sa forme inscrite ET sa forme entière (B7 : jamais un refus à tort, la
  // règle de la lettre seule).
  const refusEnclos = verifierEnclos(
    db,
    sender,
    destinataires.map((m) => formesDuMembre(m.adresse)),
    { horsEnclos: entree.hors_enclos === true, chaiseId }
  );
  if (refusEnclos) throw erreurHorsEnclos(refusEnclos, sender);

  const envoiId = `envoi-${crypto.randomUUID()}`;
  const clefDEntree = String(entree.msg_id ?? "").trim();
  const estAMoi = (row) => formes.some((forme) => estLeCourrierDe(forme)(row));
  const filTape = entree.thread_id || entree.threadId || null;
  const threadId = filTape || envoiId;
  const sansCopie = Number(table.fermee) === 1 ? 1 : 0;
  const priority = normalizePriority(entree.priority);
  const reaction = Boolean(entree.reponse_a);
  const mentions = new Set([entree.reveiller ?? []].flat().map((a) => String(a || "").trim()).filter(Boolean));
  // B9 (relecture du guichet) : une mention vise un MEMBRE sous l'une de ses
  // formes acceptées — l'adresse inscrite, sa forme entière (chaise courte), sa
  // lignée, ou, pour un membre inscrit en lignée, une de ses chaises ou de ses
  // adresses humaines. Une chaise sœur ne réveille pas une chaise inscrite.
  const formesMentionnees = new Set([...mentions].flatMap((mention) => {
    const chaise = canoniserLaChaiseCourte(db, { recipient: mention }, { resoudre }).chaiseCourte?.chaise;
    return chaise ? [mention, chaise] : [mention];
  }));
  const ligneeDe = (adresse) => adresse.split(/[#@]/)[0];
  // m6 (re-revue du round FINAL) : une mention de CHAISE (`lignée#…`, `lignée@…`)
  // ne vaut pour un membre inscrit en lignée que si cette chaise est CONNUE — une
  // fiche `peers` sous ce nom, ou une adresse que la résolution mène à une chaise
  // de cette lignée. `bob#zzzzzzzz` ne réveille personne. Lu une fois par mention.
  const connues = new Map();
  const chaiseConnue = (mention, lignee) => {
    const clef = `${lignee}\u0000${mention}`;
    if (!connues.has(clef)) {
      let connue = false;
      try {
        connue = Boolean(getInstance(db, mention));
      } catch {
        connue = false; // une fiche illisible ne réveille personne
      }
      if (!connue) {
        const cibles = resoudreSansCasser(db, mention, { resoudre })?.targets || [];
        connue = cibles.some((cible) => cible?.instance_session_id && String(cible.lineage ?? ligneeDe(String(cible.id ?? ""))) === lignee);
      }
      connues.set(clef, connue);
    }
    return connues.get(clef);
  };
  const mentionne = (adresse) => formesDuMembre(adresse).some((forme) => {
    if (formesMentionnees.has(forme) || formesMentionnees.has(ligneeDe(forme))) return true;
    return forme === ligneeDe(forme)
      && [...formesMentionnees].some((mention) => mention !== forme && ligneeDe(mention) === forme && chaiseConnue(mention, forme));
  });
  // C1 — un scan pour tout l'envoi ; fourni, on le réutilise.
  const maisons = deps.maisons || scannerSansCasser({ scanner: deps.scanner });

  const posterAvecLesDeps = (base, lettre) => posterUneLettre(base, lettre, { ...deps, maisons });

  const lettres = [];
  for (const membre of destinataires) {
    const { sansReveil, motif } = deciderLeReveil({
      priority,
      tableReveil: table.reveil,
      membreReveil: membre.reveil ?? null,
      reaction,
      modeTable: table.mode,
      mentionne: mentionne(membre.adresse)
    });
    const lettreDuMembre = {
      msg_id: clefDEntree ? `${clefDEntree}${SEPARATEUR_INSTANCE}${membre.adresse}` : undefined,
      sender,
      sender_chaise: chaiseId,
      recipient: membre.adresse,
      subject: entree.subject,
      // ⑦ — les deux orthographes vont à la base, qui tranche seule.
      body: entree.body,
      text: entree.text,
      thread_id: threadId,
      priority: entree.priority,
      msg_type: entree.msg_type,
      type: entree.type,
      sender_model: entree.sender_model,
      senderModel: entree.senderModel,
      envoi_id: envoiId,
      table_nom: table.nom,
      reponse_a: entree.reponse_a || null,
      sans_reveil: sansReveil ? 1 : 0,
      sans_copie: sansCopie,
      hors_enclos: entree.hors_enclos === true
    };
    let poste;
    try {
      poste = await posterSousUneClefASoi(db, lettreDuMembre, { estAMoi, poster: posterAvecLesDeps });
    } catch (erreur) {
      throw erreurEnvoiInterrompu(db, erreur, { nomTable: table.nom, envoiId, adresse: membre.adresse, adresses: formesDuMembre(membre.adresse), lettres, motif });
    }
    const { row, wake, attente, rejeu, ecarte, clefEcartee } = poste;
    const ecarteTape = ecarteDuPosteur(ecarte, { filTape });
    lettres.push({
      to: membre.adresse,
      row,
      wake,
      attente,
      // R2 — de LA LIGNE, comme `wake` : sur un rejeu, la lettre en base dit si
      // elle réveille, et le motif de CET appel ne s'applique à rien.
      sans_reveil: Number(row.sans_reveil) === 1,
      motif_reveil: rejeu ? "rejeu" : motif,
      ...(rejeu ? { rejeu } : {}),
      ...(ecarteTape ? { ecarte: ecarteTape } : {}),
      ...(clefEcartee ? { clef_ecartee: clefEcartee } : {})
    });
  }

  return {
    table: {
      nom: table.nom,
      mode: table.mode,
      reveil: table.reveil,
      fermee: Number(table.fermee) === 1,
      position: table.position ?? null
    },
    envoi_id: envoiId,
    count: lettres.length,
    lettres
  };
}
