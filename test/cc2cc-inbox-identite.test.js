// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA GARDE D'IDENTITÉ MANQUAIT À LA CLI (remède de la revue adverse #4, trouvaille HAUT 1). Le
// guichet MCP refuse un `self` déclaré hors de la famille dérivée depuis G1
// (`verifierIdentiteDeclaree`) ; `cc2cc-inbox` (CLI) ne vérifiait RIEN —
// l'ancien assistant de la CLI prenait `--self`/`--from` au mot. Preuve reproduite AVANT ce
// remède : une session `bob` lançant `cc2cc-inbox --self alice` lisait le
// courrier d'alice, avançait son delivered_at, ET journalisait
// `agent_id: "alice"` (l'attribution FORGÉE — le vrai lecteur, bob, ne
// laissait AUCUNE trace), alors que la même requête au guichet MCP se
// refusait déjà avec `releve-refusee`.
// ⚠️ Bases JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant n'ouvre jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { insertMessage, openDatabase } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-inbox-identite-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-inbox-identite-"));
}

function lancerInbox(root, env, args = []) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-inbox.js"), ...args], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, ...env }
  });
}

test("cc2cc-inbox --self hors de la famille dérivée est REFUSÉ, exit non-zéro, jamais lu", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  insertMessage(db, { msg_id: "L-secret", sender: "a", recipient: "alice", body: "SECRET-DE-ALICE" });

  const resultat = lancerInbox(root, { CC2CC_SELF: "bob" }, ["--self", "alice"]);
  const contenu = JSON.parse(resultat.stdout);

  assert.equal(contenu.refus, "releve-refusee", "même vocabulaire que le refus MCP");
  assert.equal(contenu.motif, "only the recipient collects its mail");
  assert.equal(contenu.declare, "alice");
  assert.equal(contenu.derivee, "bob");
  assert.notEqual(resultat.status, 0, "un refus est un échec, pas un succès silencieux");

  // Le courrier n'est même pas ouvert : ni lu, ni marqué.
  const lettre = db.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-secret'").get();
  assert.equal(lettre.delivered_at, null, "aucun effet de bord — le refus arrive AVANT toute lecture");
});

test("cc2cc-inbox sous son propre nom dérivé fonctionne toujours (le chemin sain n'est pas touché)", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  db.close();

  const sortie = JSON.parse(lancerInbox(root, { CC2CC_SELF: "posteur-legitime" }).stdout);
  assert.equal(sortie.self, "posteur-legitime");
  assert.equal(sortie.count, 0);
});

// Fix round 2 de la boucle Task 12 (re-revue r1, 28/09) : la porte large est
// fermée — un nom NU ne relève plus en propriétaire l'adresse d'une chaise
// vivante de session (règle en base, `signataireNuVersUneChaise`). L'acteur
// réel reste prouvé sur un chemin encore autorisé : une CHAISE dérivée qui
// déclare SA lignée.
test("un nom NU ne relève pas la chaise de sa lignée par la CLI ; une chaise dérivée relève sa lignée, acteur réel gardé", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const chaise = registerInstance(db, { lineage: "alice-cli", sessionId: "sess-chaise-cli-1" }).id;
  insertMessage(db, { msg_id: "L-nominative", sender: "a", recipient: chaise, body: "pour la chaise" });
  insertMessage(db, { msg_id: "L-lignee", sender: "a", recipient: "alice-cli", body: "pour la lignée" });
  db.close();

  const nu = JSON.parse(lancerInbox(root, { CC2CC_SELF: "alice-cli" }, ["--self", chaise]).stdout);
  assert.equal(nu.refus, "releve-refusee", "un nom nu ne se déclare pas une chaise vivante");

  const resultat = lancerInbox(root, { CC2CC_SELF: chaise }, ["--self", "alice-cli"]);
  const sortie = JSON.parse(resultat.stdout);
  assert.equal(sortie.refus, undefined, "une chaise déclare sa lignée, sans refus");
  assert.deepEqual(sortie.messages.map((m) => m.msg_id), ["L-lignee"]);

  // L'ACTEUR RÉEL (remède de la revue adverse #4, deuxième moitié) : `agent_id` porte le nom
  // DÉCLARÉ, et le detail_json garde la chaise qui a VRAIMENT lancé la commande.
  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => lecture.close());
  const evenement = lecture
    .prepare("SELECT agent_id, detail_json FROM delivery_events WHERE msg_id = 'L-lignee' AND event_type = 'cli_inbox_delivered'")
    .get();
  assert.equal(evenement.agent_id, "alice-cli", "l'attribution écrite reste le destinataire déclaré");
  assert.equal(JSON.parse(evenement.detail_json).acteur_reel, chaise, "mais l'acteur RÉEL est gardé, jamais maquillé");
});

test("acteur_reel n'apparaît PAS quand déclaré === dérivé — le silence des cas sains", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "L-direct", sender: "a", recipient: "posteur-direct", body: "x" });
  db.close();

  lancerInbox(root, { CC2CC_SELF: "posteur-direct" });

  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => lecture.close());
  const evenement = lecture
    .prepare("SELECT detail_json FROM delivery_events WHERE msg_id = 'L-direct' AND event_type = 'cli_inbox_delivered'")
    .get();
  assert.deepEqual(JSON.parse(evenement.detail_json), {}, "pas de champ acteur_reel quand il n'ajoute aucune information");
});

// MINEUR 7 (review interne) : `--from` était un second levier de forge AVANT
// ce remède (l'ancien assistant de la CLI le lisait comme synonyme de --self,
// sans vérification). Cette commande-ci ne le lit plus DU
// TOUT — mais un silence aurait été pire que ce qu'il remplace : sans ce
// refus explicite, `--from alice` rendrait la boîte du POSTEUR (pas alice)
// avec un succès, un résultat qui a l'air bon et ne l'est pas.
test("cc2cc-inbox --from est refusé EXPLICITEMENT, jamais un no-op qui rend la mauvaise boîte en silence", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => db.close());
  insertMessage(db, { msg_id: "L-secret-from", sender: "a", recipient: "alice", body: "SECRET-VIA-FROM" });

  const resultat = lancerInbox(root, { CC2CC_SELF: "bob" }, ["--from", "alice"]);
  assert.match(resultat.stderr, /does not accept --from/, "le refus NOMME le drapeau refusé, pas un échec muet");
  assert.notEqual(resultat.status, 0, "un refus est un échec, pas un succès silencieux sur la mauvaise boîte");
  assert.equal(resultat.stdout, "", "aucune boîte — ni celle d'alice, ni celle du posteur — n'est rendue");

  const lettre = db.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-secret-from'").get();
  assert.equal(lettre.delivered_at, null, "aucun effet de bord — le refus arrive avant toute lecture");
});

// A3 (revue de l'inconnu F4, 18/10) — LA CLI SAIT ACCUSER.
//
// « Any agent that can run a command can post and collect mail » : elle postait
// et relevait, mais aucune commande ne signait un accusé — une lettre relevée au
// CLI revenait à chaque relève, pour toujours (A9 : seul `acked_at` est
// terminal). `valxos-inbox --ack <msg_id>` accuse sous le nom DÉRIVÉ, par les
// MÊMES gardes que l'outil MCP `ack` : la vérification d'un `--self` déclaré
// (`verifierIdentiteDeclaree`) puis `ackMessage` (la garde par lettre, la copie
// cc, le nom nu vers une chaise). Aucune seconde règle ici — la parité avec le
// guichet MCP est éprouvée dans test/parite-cli-guichet.test.js.
function accuserParLaCLI(root, env, ...args) {
  const resultat = lancerInbox(root, env, ["--ack", ...args]);
  return { ...resultat, json: resultat.stdout.trim() ? JSON.parse(resultat.stdout) : null };
}

function accuseEnBase(root, msgId) {
  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  try {
    return lecture.prepare("SELECT acked_at FROM messages WHERE msg_id = ?").get(msgId)?.acked_at ?? null;
  } finally {
    lecture.close();
  }
}

function recusEnBase(root, msgId) {
  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  try {
    return lecture
      .prepare("SELECT agent_id, detail_json FROM delivery_events WHERE msg_id = ? AND event_type = 'accuse_refuse' ORDER BY id")
      .all(msgId)
      .map((e) => ({ agent_id: e.agent_id, ...JSON.parse(e.detail_json) }));
  } finally {
    lecture.close();
  }
}

test("A3 — valxos-inbox --ack accuse la lettre de SON destinataire : acked_at posé, la relève ne la rend plus", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "A3-legit", sender: "a", recipient: "alice-ack", body: "à signer" });
  db.close();

  const avant = JSON.parse(lancerInbox(root, { CC2CC_SELF: "alice-ack" }).stdout);
  assert.equal(avant.count, 1, "SONDE : la lettre est relevée, et reviendrait à chaque relève");

  const accuse = accuserParLaCLI(root, { CC2CC_SELF: "alice-ack" }, "A3-legit");
  assert.equal(accuse.status, 0, `${accuse.stdout}\n${accuse.stderr}`);
  assert.equal(accuse.json.acked, true);
  assert.equal(accuse.json.msg_id, "A3-legit");
  assert.match(accuse.json.acked_at, /^\d{4}-\d{2}-\d{2}T/, "l'heure de l'accusé est rendue");
  assert.equal(accuseEnBase(root, "A3-legit"), accuse.json.acked_at, "et c'est celle de la base");

  assert.equal(JSON.parse(lancerInbox(root, { CC2CC_SELF: "alice-ack" }).stdout).count, 0, "accusée, elle ne revient plus");

  const encore = accuserParLaCLI(root, { CC2CC_SELF: "alice-ack" }, "A3-legit");
  assert.equal(encore.status, 0);
  assert.equal(encore.json.acked_at, accuse.json.acked_at, "accuser deux fois ne réécrit pas l'heure (COALESCE)");
});

test("A3 — la lettre d'autrui n'est pas accusable : accuse-refuse-lettre, exit 1, acked_at nul, refus journalisé", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "A3-autrui", sender: "a", recipient: "alice-ack", body: "pas pour bob" });
  db.close();

  const refus = accuserParLaCLI(root, { CC2CC_SELF: "bob-ack" }, "A3-autrui");
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  assert.equal(refus.json.acked, false);
  assert.equal(refus.json.refus, "accuse-refuse-lettre", "le refus PAR LETTRE, comme au guichet MCP");
  assert.equal(refus.json.refuse, true);
  assert.equal(refus.json.destinataire, "alice-ack");
  assert.equal(refus.json.signataire, "bob-ack");
  assert.equal(accuseEnBase(root, "A3-autrui"), null, "la lettre est intacte");
  assert.deepEqual(recusEnBase(root, "A3-autrui").map((e) => e.refus), ["accuse-refuse-lettre"], "le refus laisse son reçu");
});

test("A3 — un --self hors de la famille dérivée est refusé AVANT la lettre : accuse-refuse, exit 1, journal sous le nom dérivé", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "A3-forge", sender: "a", recipient: "alice-ack", body: "secret" });
  db.close();

  const refus = accuserParLaCLI(root, { CC2CC_SELF: "bob-ack" }, "A3-forge", "--self", "alice-ack");
  assert.equal(refus.status, 1, `${refus.stdout}\n${refus.stderr}`);
  assert.equal(refus.json.acked, false);
  assert.equal(refus.json.refus, "accuse-refuse", "la garde d'identité, pas la garde par lettre");
  assert.equal(refus.json.motif, "only the recipient signs");
  assert.equal(refus.json.declare, "alice-ack");
  assert.equal(refus.json.derivee, "bob-ack");
  assert.equal(accuseEnBase(root, "A3-forge"), null);
  const reçus = recusEnBase(root, "A3-forge");
  assert.equal(reçus.length, 1);
  assert.equal(reçus[0].agent_id, "bob-ack", "l'attribution est celle de la main réelle, jamais le nom forgé");
  assert.equal(reçus[0].guichet, "valxos-inbox");
});

test("A3 — une lettre inconnue n'est pas un accusé refusé : lettre-inconnue, exit 1, RIEN au journal", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  db.close();

  const inconnue = accuserParLaCLI(root, { CC2CC_SELF: "alice-ack" }, "n-a-jamais-existe");
  assert.equal(inconnue.status, 1, `${inconnue.stdout}\n${inconnue.stderr}`);
  assert.equal(inconnue.json.acked, false);
  assert.equal(inconnue.json.refus, "lettre-inconnue");
  assert.deepEqual(recusEnBase(root, "n-a-jamais-existe"), [], "un journal peuplé de msg_id inventés se cesse de lire");
});

test("A3 — un nom NU ne signe pas la lettre d'une chaise vivante de sa lignée ; la chaise elle-même la signe", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const chaise = registerInstance(db, { lineage: "alice-ack2", sessionId: "sess-ack-cli-1" }).id;
  insertMessage(db, { msg_id: "A3-chaise", sender: "a", recipient: chaise, body: "pour la chaise" });
  db.close();

  const nu = accuserParLaCLI(root, { CC2CC_SELF: "alice-ack2" }, "A3-chaise");
  assert.equal(nu.status, 1, `${nu.stdout}\n${nu.stderr}`);
  assert.equal(nu.json.refus, "accuse-refuse-lettre");
  assert.equal(accuseEnBase(root, "A3-chaise"), null, "le nom nu n'a rien signé");

  const parLaChaise = accuserParLaCLI(root, { CC2CC_SELF: chaise }, "A3-chaise");
  assert.equal(parLaChaise.status, 0, `${parLaChaise.stdout}\n${parLaChaise.stderr}`);
  assert.equal(parLaChaise.json.acked, true);
});

test("A3 — --ack veut UN msg_id : sans valeur, répété, ou mêlé aux options de relève, il refuse (2) sans rien accuser", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "A3-un", sender: "a", recipient: "alice-ack", body: "un" });
  insertMessage(db, { msg_id: "A3-deux", sender: "a", recipient: "alice-ack", body: "deux" });
  db.close();
  const env = { CC2CC_SELF: "alice-ack" };

  const sansValeur = lancerInbox(root, env, ["--ack"]);
  assert.equal(sansValeur.status, 2);
  assert.match(sansValeur.stderr, /Missing value for --ack/);

  const repete = lancerInbox(root, env, ["--ack", "A3-un", "--ack", "A3-deux"]);
  assert.equal(repete.status, 2, `${repete.stdout}\n${repete.stderr}`);
  assert.match(repete.stderr, /one msg_id/, "le refus dit pourquoi : un accusé par appel");

  const mele = lancerInbox(root, env, ["--ack", "A3-un", "--limit", "3"]);
  assert.equal(mele.status, 2, `${mele.stdout}\n${mele.stderr}`);
  assert.match(mele.stderr, /cannot be combined/);

  assert.equal(accuseEnBase(root, "A3-un"), null, "aucun de ces refus n'a accusé quoi que ce soit");
  assert.equal(accuseEnBase(root, "A3-deux"), null);
});

// Le README et docs/MCP_CLIENTS.md disent « acknowledge with `valxos-inbox --ack <msg_id>` » :
// l'aide imprimée — par --help comme par -h — la nomme, avec sa forme et son rôle.
for (const drapeau of ["--help", "-h"]) {
  test(`A3 — l'aide de valxos-inbox (${drapeau}) nomme --ack MSG_ID et dit qu'il accuse UNE lettre`, () => {
    const aide = lancerInbox(maisonJetable(), {}, [drapeau]);
    assert.equal(aide.status, 0, aide.stderr);
    assert.match(aide.stdout, /valxos-inbox --ack MSG_ID \[--self NAME\]/);
    assert.match(aide.stdout, /acknowledge one letter/);
  });
}
