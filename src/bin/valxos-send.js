#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { getDatabase, recordEvent, registerPeer, verifierIdentiteDeclaree } from "../lib/database.js";
import { origineDuNomDerive } from "../lib/config.js";
// ② — LA LOI DU COURRIER NE S'ÉCRIT PLUS ICI. Ce binaire est PUBLIÉ
// (`bin.cc2cc-send`) et il refaisait les quatre gestes d'un envoi de sa propre
// main : inscrire, résoudre, réveiller, avertir — donc les trois remèdes
// (C1, C2, R2) en DEUXIÈME exemplaire. Preuve du coût, mesurée avant ce
// remède : casser R2 dans le guichet faisait rougir le guichet et le MCP, et
// laissait VERT « le rejeu d'un msg_id connu dit vrai aussi par le CLI »
// (test/rejeu-idempotent.test.js) — cette surface-ci pouvait mentir seule.
// Elle appelle désormais, comme le MCP et comme la porte web appellera.
import {
  borne,
  codeDeLaCause,
  estLeCourrierDe,
  interruptionDEnvoi,
  lettreDeTableRendue,
  nomDeTableDe,
  posterAUneTable,
  posterSousUneClefASoi
} from "../lib/guichet.js";
import { deriveSelfOuRefus, optionalArg, parseArgs, printJson, requireArg, terminer } from "./cli-common.js";

// 1.1.0 : `--to table:<nom>` poste par `posterAUneTable` (une lettre par membre,
// SPEC_A §2) ; `--reveiller a,b` nomme les membres réveillés quelle que soit la
// règle ; `--hors-enclos` (booléen : il n'avale jamais le mot suivant) est la
// clef d'un expéditeur enclos (SPEC_A §4).
const args = parseArgs(process.argv.slice(2), {
  known: ["to", "body", "subject", "thread_id", "priority", "type", "msg_id", "self", "from", "reveiller"],
  booleans: ["hors_enclos"],
  usage: "usage: valxos-send --to NAME|table:NAME --body TEXT [--subject S] [--thread-id T] [--priority low|normal|high|critical] [--type T] [--msg-id ID] [--self NAME] [--reveiller A,B] [--hors-enclos]"
});
// L'identité dérivée, avant le bureau : refusée (S10), rien ne s'ouvre.
const derive = deriveSelfOuRefus("valxos-send");
const db = getDatabase();
// L'EXPÉDITEUR SE VÉRIFIE (fix round 2 de la boucle Task 12, re-revue r1, M-1) :
// `--self`/`--from` étaient pris au mot, et `--self carol` faisait passer la
// clef d'une lettre carol→dave pour la sienne (F12 rouvert). Comme
// `valxos-inbox`, le nom déclaré passe `verifierIdentiteDeclaree` contre le nom
// DÉRIVÉ (l'environnement) avant tout ; refusé → rien n'est posé, sortie 1. La
// propriété d'une clef se juge ensuite sur le nom dérivé seul.
const declare = String(optionalArg(args, "self") ?? optionalArg(args, "from") ?? "").trim();
if (declare && declare !== derive) {
  const identite = verifierIdentiteDeclaree(db, derive, declare);
  if (!identite.autorise) {
    recordEvent(db, null, derive, "accuse_refuse", {
      refus: "expediteur-refuse", declare, derivee: derive, raison: identite.raison, guichet: "valxos-send"
    });
    printJson({
      sent: false,
      refus: "expediteur-refuse",
      motif: "a sender writes only under its own name",
      declare,
      derivee: derive,
      origine: origineDuNomDerive(),
      raison: identite.raison
    });
    // Sortie après le drain (H2 : un `process.exit` juste après l'écriture
    // peut tronquer sur un tube) ; la promesse jamais tenue arrête le module
    // ici, rien d'autre ne s'exécute.
    terminer(1);
    await new Promise(() => {});
  }
}
// UN NOM DÉCLARÉ ACCEPTÉ N'EST PAS L'EXPÉDITEUR (J4, jury, 18/10). `--from`/`--self`
// <ancien nom qui mène à l'appelant> passait la vérification ci-dessus, puis la lettre
// partait sous ce nom DÉCLARÉ : `posterSousUneClefASoi` ne la jugeait pas « à moi »
// (elle ne porte pas le nom dérivé), reposait sous une clef neuve et levait — deux
// lettres, sortie 1, et une fiche de pair créée pour l'ancien nom. La CLI n'a pas de
// chaise : un nom déclaré accepté n'est qu'une demande vérifiée, et la lettre part
// sous le nom DÉRIVÉ, comme la propriété de la clef se juge sur lui.
const sender = derive;
const to = requireArg(args, "to");
const body = optionalArg(args, "body") || args._.join(" ");
if (!body) {
  process.stderr.write("Missing required --body or positional body text\n");
  process.exit(2);
}
// Le nom après `table:` (sans casse, comme au guichet), ou null pour un envoi direct.
const nomDeTable = nomDeTableDe(to);
const reveiller = String(optionalArg(args, "reveiller") ?? "").split(",").map((adresse) => adresse.trim()).filter(Boolean);
if (optionalArg(args, "reveiller") !== undefined && nomDeTable === null) {
  // Une mention ne vaut que dans une table : la taire sur un envoi direct
  // laisserait croire qu'elle a réveillé quelqu'un.
  process.stderr.write("--reveiller applies to table sends only (--to table:NAME).\nNothing was done.\n");
  process.exit(2);
}
const horsEnclos = args.hors_enclos === true;

// UN REFUS DU GUICHET SE DIT EN JSON, SORTIE 2 (1.1.0) — jamais une pile. Les
// codes que le guichet et le carnet lèvent sont des refus : le guichet refuse
// AVANT d'inscrire, rien n'a été écrit, et le posteur lit le code et ses
// raisons (`hors-enclos` porte `enclos`, `destinataires_refuses`, `autres` ;
// `enclos-conflit`, S9, porte `tables` et `enclos_poses`).
// UN ENVOI DE TABLE QUI CASSE EN CHEMIN dit ce qui est parti, sous la forme
// du guichet MCP (`interruptionDEnvoi`) : `lettres_ecrites`, `envoi_id`,
// `table`, `adresse`, et `refus` garde le code d'origine quand c'est un des
// nôtres (un enclos posé pendant l'envoi), sinon `envoi-interrompu` avec le
// code brut dans `cause` — jamais « rien d'écrit » à tort. Toute autre erreur
// qui n'a rien écrit remonte telle quelle (pile, sortie 1), comme avant.
const REFUS_DU_GUICHET = new Set([
  "hors-enclos",
  "enclos-conflit",
  "parametre-invalide",
  "table-inconnue",
  "pas-membre",
  "nom-de-table-invalide",
  "table-existe",
  "table-fermee",
  "table-sous-enclos",
  "enclos-table-ouverte",
  "reveil-invalide",
  "mode-invalide",
  "adresse-invalide"
]);

async function refusDuGuichet(erreur, champs = {}) {
  const interruption = interruptionDEnvoi(erreur);
  const connu = REFUS_DU_GUICHET.has(erreur?.code);
  if (!connu && !interruption) throw erreur;
  const refus = connu ? erreur.code : "envoi-interrompu";
  printJson({
    sent: false,
    refus,
    motif: erreur.message,
    ...champs,
    ...(erreur.enclos ? { enclos: erreur.enclos } : {}),
    ...(erreur.destinataires_refuses ? { destinataires_refuses: erreur.destinataires_refuses } : {}),
    ...(erreur.autres ? { autres: erreur.autres } : {}),
    // S9 : deux enclos vers deux tables — lesquelles, et sur quelles formes.
    ...(erreur.tables ? { tables: erreur.tables } : {}),
    ...(erreur.enclos_poses ? { enclos_poses: erreur.enclos_poses } : {}),
    ...(erreur.parametre ? { parametre: erreur.parametre } : {}),
    ...(interruption
      ? {
          interrompu: true,
          envoi_id: interruption.envoi_id,
          table: interruption.table,
          adresse: interruption.adresse,
          lettres_ecrites: interruption.lettres_ecrites,
          ...(connu || !codeDeLaCause(erreur) ? {} : { cause: codeDeLaCause(erreur) })
        }
      : {})
  });
  if (interruption) {
    process.stderr.write(
      `${interruption.lettres_ecrites.length} letter(s) sent, then ${refus}: the letters in lettres_ecrites were written, the others were not.\n`
    );
  }
  terminer(2);
  await new Promise(() => {});
}

registerPeer(db, {
  id: sender,
  project_path: process.cwd(),
  description: "VALXOS Messenger CLI sender",
  status: "active"
});

if (nomDeTable !== null) {
  // LA LETTRE À UNE TABLE : le guichet écrit une lettre par membre actif hors des
  // formes de l'expéditeur, un seul scan des maisons (C1), un `envoi_id` commun.
  // La CLI n'a pas de chaise : `sender_chaise` reste nul, et l'en-tête des
  // destinataires dira le nom dérivé seul.
  let envoi;
  try {
    envoi = await posterAUneTable(db, {
      sender,
      sender_chaise: null,
      table: nomDeTable,
      subject: optionalArg(args, "subject"),
      body,
      thread_id: optionalArg(args, "thread_id"),
      priority: optionalArg(args, "priority"),
      msg_type: optionalArg(args, "type"),
      msg_id: optionalArg(args, "msg_id"),
      reveiller,
      hors_enclos: horsEnclos
    });
  } catch (erreur) {
    await refusDuGuichet(erreur, { table: erreur?.table ?? borne(nomDeTable) });
  }
  printJson({
    sent: true,
    // La table entière (`{ nom, mode, reveil, fermee, position }`), comme l'outil MCP `send`.
    table: envoi.table,
    envoi_id: envoi.envoi_id,
    count: envoi.count,
    from: sender,
    // La forme de l'outil MCP `send` pour une table (`lettreDeTableRendue`, au
    // guichet) : un résultat par lettre, dérivé de LA LIGNE (R2), l'avis quand
    // elle attend, `rejeu`/`ecarte`/`clef_ecartee` quand le guichet les pose.
    results: envoi.lettres.map((lettre) => lettreDeTableRendue(lettre, envoi.envoi_id))
  });
} else {
  // F12 (28/09) : jamais sous la clef d'un tiers (la règle vit au guichet).
  // L'ENCLOS (1.1.0) : le guichet refuse avant d'écrire ; le refus se rend.
  let poste;
  try {
    poste = await posterSousUneClefASoi(db, {
      msg_id: optionalArg(args, "msg_id"),
      sender,
      recipient: to,
      subject: optionalArg(args, "subject"),
      body,
      thread_id: optionalArg(args, "thread_id"),
      priority: optionalArg(args, "priority"),
      msg_type: optionalArg(args, "type"),
      hors_enclos: horsEnclos
    }, { estAMoi: estLeCourrierDe(derive) });
  } catch (erreur) {
    await refusDuGuichet(erreur, { to: borne(to) });
  }
  const { row, wake, attente, rejeu, ecarte, clefEcartee } = poste;
  printJson({
    sent: true,
    msg_id: row.msg_id,
    seq: row.seq,
    // ⑨ — `from` SE DÉRIVE DE LA LIGNE, EXACTEMENT COMME `to`. Le dernier
    // demi-geste de R2 : cette réponse mélangeait deux sources — `to` venait de
    // la base, `from` venait de la variable de CET appel-ci. Sur un rejeu elle
    // attribuait donc la lettre à quelqu'un qui ne l'avait pas écrite (mesuré :
    // même msg_id, `--self exp-deux`, réponse `from: exp-deux`, base `exp-un`).
    // Une réponse qui décrit une lettre la décrit ENTIÈRE depuis la ligne.
    from: row.sender,
    to: row.recipient,
    wake,
    ...(attente ? { attente } : {}),
    ...(rejeu ? { rejeu } : {}),
    // ⑧ — un posteur dont le texte est jeté l'apprend. Sur un renvoi idempotent
    // honnête `ecarte` est nul et la sortie ne bouge pas d'un octet ; il n'apparaît
    // que quand quelque chose a VRAIMENT été perdu, et il porte la valeur perdue.
    ...(ecarte ? { ecarte } : {}),
    // F12 — la clef demandée était au courrier d'un tiers : la lettre est
    // partie, sous une clef neuve. Le taire, c'est laisser croire qu'on tient le pli.
    ...(clefEcartee ? { clef_ecartee: { demandee: clefEcartee, motif: "clef-deja-prise" } } : {})
  });
}
