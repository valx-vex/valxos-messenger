// Le garde des aides sur la 1.1.0 (16/11/2026). Le garde est là
// depuis le 27/09 (`c00c640`, `deciderLaChaise` → « sous-agent »). Ces tests
// ferment deux trous que la relecture adverse du 16/11 a vus sur le même garde
// de la 1.0.0 : une session `--agent` (`agent_type` seul) doit relever son
// courrier (mutant M3), et une aide ne touche pas au registre (mutant M9b).
//
// Une aide (un sous-agent) ne relève jamais le courrier de sa chaise. Claude
// Code met `agent_id` dans l'entrée d'un crochet quand l'outil a été appelé
// par un sous-agent (sondé le 16/11 sur 2.1.323 ; le schéma de 2.1.325 dit :
// « Present only when the hook fires from within a subagent… Absent for the
// main thread »). Sans ce garde, la lettre allait dans le contexte de l'aide,
// et elle était marquée remise : la chaise pouvait ne jamais la voir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { insertMessage, openDatabase } from "../src/lib/database.js";
import { migrate } from "../src/lib/migrations.js";
import { registerInstance } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repoRacine = path.resolve(new URL("..", import.meta.url).pathname);

function bureauAvecUneLettre(msgId, corps, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-garde-aides-"));
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  migrate(db);
  insertMessage(db, { msg_id: msgId, sender: "bob", recipient: "hook-agent#sess-42", body: corps, ...extra });
  db.close();
  return root;
}

function crochet(root, fichier, entree) {
  return spawnSync("node", [path.join(repoRacine, "src/hooks", fichier)], {
    input: JSON.stringify({ session_id: "sess-42", cwd: "/h", ...entree }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "hook-agent", VALXOS_SELF: "hook-agent" }
  });
}

function lire(root, sql, ...args) {
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    return db.prepare(sql).get(...args);
  } finally {
    db.close();
  }
}

test("une aide (sous-agent) ne relève pas le courrier de sa chaise, et ne le marque pas remis", () => {
  const root = bureauAvecUneLettre("L-aide", "pour la chaise, pas pour l'aide");
  const chezLAide = crochet(root, "piggyback_fetch.js", {
    hook_event_name: "PostToolUse", agent_id: "a3e5ed251c8788a8", agent_type: "general-purpose"
  });
  assert.equal(chezLAide.status, 0, chezLAide.stderr);
  assert.deepEqual(JSON.parse(chezLAide.stdout), {}, "l'aide ne voit pas la lettre");
  assert.equal(lire(root, "SELECT delivered_at FROM messages WHERE msg_id = ?", "L-aide").delivered_at, null,
    "la lettre n'est pas marquée remise");
  const chezLaChaise = crochet(root, "piggyback_fetch.js", { hook_event_name: "PostToolUse" });
  assert.match(JSON.parse(chezLaChaise.stdout).hookSpecificOutput?.additionalContext || "", /pour la chaise, pas pour l'aide/,
    "la chaise la reçoit à son propre appel d'outil");
});

test("le filet de fin de tour ne bloque jamais au nom d'une aide", () => {
  const root = bureauAvecUneLettre("L-filet", "urgente", { priority: "high" });
  const res = crochet(root, "safety_net_poll.js", { hook_event_name: "Stop", agent_id: "a3e5ed251c8788a8" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {});
});

test("une session lancée en agent (`agent_type` seul, sans `agent_id`) reste la chaise : elle relève son courrier", () => {
  const root = bureauAvecUneLettre("L-agent", "pour la session agent");
  const res = crochet(root, "piggyback_fetch.js", { hook_event_name: "PostToolUse", agent_type: "mon-agent" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).hookSpecificOutput?.additionalContext || "", /pour la session agent/);
});

test("une aide ne touche pas au registre : la chaise garde son `last_seen`", () => {
  const root = bureauAvecUneLettre("L-registre", "rien");
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "hook-agent", sessionId: "sess-42", house: "/h", pid: process.pid });
  db.close();
  const avant = lire(root, "SELECT last_seen FROM peers WHERE instance_session_id = ?", "sess-42").last_seen;
  const res = crochet(root, "piggyback_fetch.js", { hook_event_name: "PostToolUse", agent_id: "a3e5ed251c8788a8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(lire(root, "SELECT last_seen FROM peers WHERE instance_session_id = ?", "sess-42").last_seen, avant);
});
