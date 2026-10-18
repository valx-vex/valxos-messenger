#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import { getDatabase, recordEvent, registerPeer, verifierIdentiteDeclaree } from "../lib/database.js";
import { deriveSelf, origineDuNomDerive } from "../lib/config.js";
// ② — LA LOI DU COURRIER NE S'ÉCRIT PLUS ICI. Ce binaire est PUBLIÉ
// (`bin.cc2cc-send`) et il refaisait les quatre gestes d'un envoi de sa propre
// main : inscrire, résoudre, réveiller, avertir — donc les trois remèdes
// (C1, C2, R2) en DEUXIÈME exemplaire. Preuve du coût, mesurée avant ce
// remède : casser R2 dans le guichet faisait rougir le guichet et le MCP, et
// laissait VERT « le rejeu d'un msg_id connu dit vrai aussi par le CLI »
// (test/rejeu-idempotent.test.js) — cette surface-ci pouvait mentir seule.
// Elle appelle désormais, comme le MCP et comme la porte web appellera.
import { estLeCourrierDe, posterSousUneClefASoi } from "../lib/guichet.js";
import { optionalArg, parseArgs, printJson, requireArg, terminer } from "./cli-common.js";

const args = parseArgs(process.argv.slice(2), {
  known: ["to", "body", "subject", "thread_id", "priority", "type", "msg_id", "self", "from"],
  usage: "usage: valxos-send --to NAME --body TEXT [--subject S] [--thread-id T] [--priority low|normal|high|critical] [--type T] [--msg-id ID] [--self NAME]"
});
const db = getDatabase();
// L'EXPÉDITEUR SE VÉRIFIE (fix round 2 de la boucle Task 12, re-revue r1, M-1) :
// `--self`/`--from` étaient pris au mot, et `--self carol` faisait passer la
// clef d'une lettre carol→dave pour la sienne (F12 rouvert). Comme
// `valxos-inbox`, le nom déclaré passe `verifierIdentiteDeclaree` contre le nom
// DÉRIVÉ (l'environnement) avant tout ; refusé → rien n'est posé, sortie 1. La
// propriété d'une clef se juge ensuite sur le nom dérivé seul.
const derive = deriveSelf();
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

registerPeer(db, {
  id: sender,
  project_path: process.cwd(),
  description: "VALXOS Messenger CLI sender",
  status: "active"
});

// F12 (28/09) : jamais sous la clef d'un tiers (la règle vit au guichet).
const { row, wake, attente, rejeu, ecarte, clefEcartee } = await posterSousUneClefASoi(db, {
  msg_id: optionalArg(args, "msg_id"),
  sender,
  recipient: to,
  subject: optionalArg(args, "subject"),
  body,
  thread_id: optionalArg(args, "thread_id"),
  priority: optionalArg(args, "priority"),
  msg_type: optionalArg(args, "type")
}, { estAMoi: estLeCourrierDe(derive) });
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
