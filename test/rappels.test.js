// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES RAPPELS ESPACÉS (1.1.0, Tâche 8). Une lettre jamais accusée revient toujours (A9), mais pas
// toutes les dix minutes pour toujours : 10, 20, 40, puis 60 minutes au plus (A8 : un doublon,
// jamais une avalanche). Chaque re-service se compte sur la lettre (`reservices`) et se nomme
// dans l'en-tête (`Reminder: n`).
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau de poste
// vivant n'est JAMAIS ouvert ici. Le plancher se pose AVANT le premier test (remède F2) ; l'état
// d'origine se restaure à la fin du fichier.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-rappels-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { DEFAULT_REDELIVER_AFTER_MS, DEFAULT_REDELIVER_CAP_MS } from "../src/lib/config.js";
import {
  ackMessage,
  enrichirPourAffichage,
  fenetreDeReService,
  getMessageById,
  getPendingForContext,
  insertMessage,
  markDelivered,
  openDatabase,
  paliersDeReService
} from "../src/lib/database.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function bureauDePoste(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-rappels-"));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { root, db };
}

// Une horloge injectée : les fenêtres se prouvent à la minute, jamais à l'horloge murale.
const DEPART = Date.parse("2026-10-21T12:00:00.000Z");
const a = (minutes) => new Date(DEPART + minutes * 60_000).toISOString();

// ── LES PALIERS ────────────────────────────────────────────────────────────────────────────────
test("la fenêtre de re-service double à chaque rappel et plafonne : 10, 20, 40, 60, 60…", () => {
  const dix = 10 * 60_000;
  const heure = 60 * 60_000;
  assert.equal(DEFAULT_REDELIVER_AFTER_MS, dix, "le défaut d'avant ne bouge pas : c'est la base");
  assert.equal(DEFAULT_REDELIVER_CAP_MS, heure, "le plafond : une heure");
  assert.deepEqual([0, 1, 2, 3, 4, 40].map((n) => fenetreDeReService(n)), [dix, 2 * dix, 4 * dix, heure, heure, heure]);
  // Des réglages, jamais des nombres en dur — et un plafond plus bas que la base ne raccourcit
  // jamais la fenêtre de base (un opérateur qui ALLONGE la base garde sa fenêtre).
  assert.deepEqual([0, 1, 2].map((n) => fenetreDeReService(n, { base: 1_000, plafond: 3_000 })), [1_000, 2_000, 3_000]);
  assert.equal(fenetreDeReService(5, { base: 7_200_000, plafond: 3_600_000 }), 7_200_000);
  // Un compte absurde (négatif, nul, absent, non numérique) compte comme 0 : jamais une fenêtre
  // plus courte que la base.
  assert.deepEqual([-1, null, undefined, "x"].map((n) => fenetreDeReService(n)), [dix, dix, dix, dix]);
  // Les paliers, pour la requête : le dernier vaut pour ce compte de rappels ET au-delà.
  assert.deepEqual(paliersDeReService(), [
    { rappels: 0, fenetreMs: dix },
    { rappels: 1, fenetreMs: 2 * dix },
    { rappels: 2, fenetreMs: 4 * dix },
    { rappels: 3, fenetreMs: heure }
  ]);
  assert.deepEqual(paliersDeReService({ base: heure, plafond: heure }), [{ rappels: 0, fenetreMs: heure }]);
  assert.deepEqual(paliersDeReService({ base: 1, plafond: 1 }), [{ rappels: 0, fenetreMs: 1 }], "base et plafond d'une milliseconde : un seul palier (le réglage des tests de hooks)");
});

// ── LE COMPTE DES RE-SERVICES ──────────────────────────────────────────────────────────────────
// La marque avançait déjà à chaque service ; elle compte maintenant les services au-delà du
// premier, sur la lettre. Tous les chemins qui marquent (hooks, `inbox` CLI et MCP, porte web)
// passent par la même fonction : un seul compte, une seule règle.
test("markDelivered compte un re-service quand la marque existait déjà — jamais au premier service", (t) => {
  const { db } = bureauDePoste(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "x" });
  insertMessage(db, { msg_id: "L2", sender: "alice", recipient: "bob", body: "y" });
  const compte = (id) => getMessageById(db, id).reservices;
  assert.equal(compte("L1"), 0, "une lettre naît sans rappel (schéma 7, défaut 0)");

  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: a(0) });
  assert.equal(compte("L1"), 0, "le PREMIER service n'est pas un rappel");
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: a(10) });
  assert.equal(compte("L1"), 1, "le deuxième service est le premier rappel");
  // La relève au guichet (`inbox`, CLI ou MCP) pose la MÊME marque : elle compte pareil.
  markDelivered(db, [lettre], "bob", "mcp_inbox_delivered", { at: a(12), acteurReel: "bob#s-1" });
  assert.equal(compte("L1"), 2);
  assert.equal(getMessageById(db, "L1").delivered_at, a(12), "la marque avance, comme avant");
  assert.equal(compte("L2"), 0, "la voisine, jamais servie, ne compte rien");
  // Une tournée vide ne touche à rien.
  assert.equal(markDelivered(db, [], "bob", "post_tool_use_delivered"), 0);
  assert.equal(compte("L1"), 2);
  // Le journal garde ses événements d'avant, un par service, inchangés.
  const evenements = db.prepare("SELECT event_type FROM delivery_events WHERE msg_id = 'L1' ORDER BY id").all().map((e) => e.event_type);
  assert.deepEqual(evenements, ["created", "post_tool_use_delivered", "post_tool_use_delivered", "mcp_inbox_delivered"]);
});

// ── L'ESPACEMENT ───────────────────────────────────────────────────────────────────────────────
// Une session qui appelle des outils relève sa boîte chaque minute. Une lettre jamais accusée
// revenait toutes les dix minutes, pour toujours ; elle revient maintenant aux minutes 10, 30, 70,
// 130, puis toutes les heures. A9 tient : elle revient TOUJOURS. A8 tient : un doublon par fenêtre,
// et des fenêtres qui s'écartent.
test("les rappels s'espacent — 10, 20, 40, puis 60 minutes entre deux retours — et ne cessent jamais", (t) => {
  const { db } = bureauDePoste(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "x" });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: a(0) });

  const retours = [];
  for (let minute = 1; minute <= 400; minute += 1) {
    const rows = getPendingForContext(db, "bob", { now: a(minute) });
    if (rows.length === 0) continue;
    retours.push(minute);
    markDelivered(db, rows, "bob", "post_tool_use_delivered", { at: a(minute) });
  }
  assert.deepEqual(retours, [10, 30, 70, 130, 190, 250, 310, 370],
    "10 puis 20 puis 40 puis 60 minutes d'écart : A8 (un doublon, jamais une avalanche) et A9 (elle revient toujours)");
  assert.equal(getMessageById(db, "L1").reservices, 8);

  // Le plafond est FINI : cent rappels plus tard, elle revient encore dans l'heure.
  db.prepare("UPDATE messages SET reservices = 100, delivered_at = ? WHERE msg_id = 'L1'").run(a(1000));
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(1059) }), [], "pas avant l'heure");
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(1060) }).map((r) => r.msg_id), ["L1"], "jamais au-delà de l'heure (A9)");

  // L'accusé reste le seul geste terminal.
  ackMessage(db, "L1", "bob");
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(5000) }), []);
});

test("la fenêtre se lit PAR LETTRE, dans la requête : une lettre rappelée deux fois ne masque pas sa voisine, la borne et le tri tiennent", (t) => {
  const { db } = bureauDePoste(t);
  insertMessage(db, { msg_id: "VIEILLE", sender: "alice", recipient: "bob", body: "x" });
  const neuve = insertMessage(db, { msg_id: "NEUVE", sender: "alice", recipient: "bob", body: "y" });
  // La vieille a déjà été rappelée deux fois (fenêtre : 40 min) ; la neuve servie une fois (10 min).
  db.prepare("UPDATE messages SET reservices = 2, delivered_at = ? WHERE msg_id = 'VIEILLE'").run(a(0));
  markDelivered(db, [neuve], "bob", "post_tool_use_delivered", { at: a(0) });
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(10) }).map((r) => r.msg_id), ["NEUVE"], "à 10 min, seule la neuve est due");
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(40) }).map((r) => r.msg_id), ["VIEILLE", "NEUVE"], "à 40 min, les deux, par ancienneté");
  // `limit: 1` avec `parUrgence` : SQLite tranche sur l'ensemble filtré, jamais un filtre JS après coup.
  db.prepare("UPDATE messages SET priority = 'high' WHERE msg_id = 'NEUVE'").run();
  assert.deepEqual(getPendingForContext(db, "bob", { now: a(40), limit: 1, parUrgence: true }).map((r) => r.msg_id), ["NEUVE"]);
  // Les réglages se passent aussi par l'appel : base 1 min, plafond 2 min.
  assert.deepEqual(
    getPendingForContext(db, "bob", { now: a(40), redeliverAfterMs: 60_000, redeliverCapMs: 120_000 }).map((r) => r.msg_id),
    ["VIEILLE", "NEUVE"],
    "la vieille (2 rappels → 2 min) et la neuve (1 min) sont dues"
  );
  assert.deepEqual(
    getPendingForContext(db, "bob", { now: a(1), redeliverAfterMs: 60_000, redeliverCapMs: 120_000 }).map((r) => r.msg_id),
    ["NEUVE"],
    "à 1 min, la vieille (2 min) attend encore"
  );
});

// ── LE RAPPEL SE NOMME ─────────────────────────────────────────────────────────────────────────
// `enrichirPourAffichage` (Tâche 4) écrit `rappel` depuis `reservices` ; sans cette tâche, les
// hooks mettaient en forme AVANT de marquer, sur la ligne d'avant la marque : le premier rappel
// disait 0 et ne se nommait jamais — aux yeux du lecteur, une lettre neuve. Les hooks marquent
// maintenant d'abord, et le rappel se lit EN BASE.
test("enrichirPourAffichage lit le rappel EN BASE, pas sur la ligne en main (la ligne date d'avant la marque)", (t) => {
  const { db } = bureauDePoste(t);
  const lettre = insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "bob", body: "x" });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: a(0) });
  markDelivered(db, [lettre], "bob", "post_tool_use_delivered", { at: a(10) });
  const [enrichie] = enrichirPourAffichage(db, [lettre]); // `lettre` porte encore reservices: 0
  assert.equal(enrichie.affichage.rappel, 1);
  assert.equal(enrichie.reservices, 0, "la ligne elle-même n'est pas réécrite : seul `affichage` s'ajoute");
  // Une ligne sans `seq` (forgée, un test de forme) fait foi d'elle-même.
  const [forgee] = enrichirPourAffichage(db, [{ msg_id: "x", sender: "alice", recipient: "bob", body: "x", reservices: 3 }]);
  assert.equal(forgee.affichage.rappel, 3);
});

// Les hooks, de bout en bout. Fenêtres d'une milliseconde (base ET plafond) : chaque relève
// re-sert. Même lanceur que test/hooks.test.js (`runHook`), plus les deux clefs de réglage.
function runHook(script, root, input, ajouts = {}) {
  return spawnSync(process.execPath, [path.join(repo, "src/hooks", script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "hook-agent", ...ajouts }
  });
}
const FENETRES_D_UNE_MS = { CC2CC_REDELIVER_AFTER_MS: "1", CC2CC_REDELIVER_CAP_MS: "1" };
const dodo = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function lignesDuContexte(sortie) {
  assert.equal(sortie.status, 0, sortie.stderr);
  return JSON.parse(sortie.stdout).hookSpecificOutput.additionalContext.split("\n");
}

test("PostToolUse nomme le rappel dès le PREMIER re-service (Reminder: 1), puis SessionStart le suivant (Reminder: 2)", (t) => {
  const { root, db } = bureauDePoste(t);
  insertMessage(db, { msg_id: "L1", sender: "alice", recipient: "hook-agent", body: "rappelle-moi" });
  db.close();

  const premiere = lignesDuContexte(runHook("piggyback_fetch.js", root, { hook_event_name: "PostToolUse" }, FENETRES_D_UNE_MS));
  assert.ok(premiere.includes("From: alice"), "la lettre est servie");
  assert.equal(premiere.some((l) => l.startsWith("Reminder:")), false, "le premier service n'est pas un rappel");

  dodo(5);
  const deuxieme = lignesDuContexte(runHook("piggyback_fetch.js", root, { hook_event_name: "PostToolUse" }, FENETRES_D_UNE_MS));
  assert.ok(deuxieme.includes("Reminder: 1"), `le premier rappel se nomme, reçu :\n${deuxieme.join("\n")}`);

  dodo(5);
  const troisieme = lignesDuContexte(runHook("startup_sync.js", root, { hook_event_name: "SessionStart" }, FENETRES_D_UNE_MS));
  assert.ok(troisieme.includes("Reminder: 2"), "SessionStart compte le sien aussi");

  const relu = openDatabase({ file: path.join(root, "broker.db") });
  assert.equal(getMessageById(relu, "L1").reservices, 2, "deux re-services, comptés sur la lettre");
  relu.close();
});
