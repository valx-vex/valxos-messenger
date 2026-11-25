// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA FICHE DE CHAISE CODEX (1.1.0, spec B §2).
//
// Codex n'écrit pas de fiche de session ; notre hook SessionStart le fait :
// `<bureau>/codex/<lignée>.json`, atomique, privée (0600), et la carte NUE de
// la lignée au registre des pairs porte le fil (`instance_session_id`) et la
// maison Codex (`house`). Jamais une chaise `lignée#fil` : le client MCP de
// la chaise Codex parle en nom nu et doit pouvoir accuser.
// Jetable : mkdtemp + CC2CC_V2_HOME, jamais le bureau vivant ; le CODEX_HOME
// des fixtures est un dossier du bureau jetable, jamais ~/.codex.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ackMessage, insertMessage, openDatabase } from "../src/lib/database.js";
import { listLineages, resolveRecipient } from "../src/lib/registry.js";
import {
  PORTES_CODEX,
  cheminDeLaFiche,
  codexHomeDe,
  ecrireFicheCodex,
  fichesCodex,
  lireFicheCodex,
  moissonnerLesFichesCodex,
  porteDeLEnvironnement,
  processusDeLaFiche,
  rafraichirFicheCodex
} from "../src/lib/chaise-codex.js";
import { poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chaise-codex-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

function bureau(t) {
  const root = poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chaise-codex-")));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { root, db, codexHome: path.join(root, "codex-home") };
}

const T0 = "2026-10-21T14:00:00.000Z";
const T1 = "2026-10-21T14:05:00.000Z";

test("ecrireFicheCodex : la fiche <bureau>/codex/<lignée>.json, atomique et privée, et la carte nue au registre porte le fil et la maison Codex", (t) => {
  const { root, db, codexHome } = bureau(t);
  const fiche = ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, cwd: "/w", now: T0 });
  assert.deepEqual(fiche, {
    lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, proc_start: fiche.proc_start,
    porte: "cli", cwd: "/w", started_at: T0, last_seen: T0, dead_at: null
  });
  assert.ok(fiche.proc_start === null || typeof fiche.proc_start === "string", "l'heure de naissance vient de ps, ou n'est pas connue");
  const fichier = path.join(root, "codex", "hal-test.json");
  assert.equal(cheminDeLaFiche("hal-test"), fichier);
  assert.deepEqual(JSON.parse(fs.readFileSync(fichier, "utf8")), fiche, "ce qui est rendu est ce qui est écrit");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, "une fiche qui nomme un fil et un pid est privée");
  assert.equal(fs.statSync(path.join(root, "codex")).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.join(root, "codex")), ["hal-test.json"], "aucun fichier temporaire ne reste");
  const row = db.prepare("SELECT * FROM peers WHERE id = 'hal-test'").get();
  assert.equal(row.lineage, "hal-test");
  assert.equal(row.instance_session_id, "thread-1");
  assert.equal(row.session_id, "thread-1");
  assert.equal(row.house, codexHome);
  assert.equal(row.pid, process.pid);
  assert.equal(row.status, "active");
  assert.equal(row.last_seen, T0);
  assert.equal(row.heartbeat_at, T0);
  assert.equal(row.description, "Codex session");
  assert.deepEqual(JSON.parse(row.metadata_json), { harnais: "codex", porte: "cli", codex_home: codexHome });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers WHERE id LIKE 'hal-test#%'").get().n, 0, "jamais une chaise lignée#fil");
  // Le guichet y mène comme à une chaise, et le nom nu accuse sa propre lettre.
  const resolution = resolveRecipient(db, "hal-test");
  assert.equal(resolution.kind, "instance");
  assert.equal(resolution.targets[0].instance_session_id, "thread-1");
  const { msg_id } = insertMessage(db, { sender: "alice", recipient: "hal-test", body: "for the Codex chair" });
  assert.ok(ackMessage(db, msg_id, "hal-test").acked_at, "le nom nu accuse ce que le hook lui livre");
});

test("lireFicheCodex : la fiche avec un résumé de sa carte ; null quand elle manque, est illisible, ou nomme une autre lignée", (t) => {
  const { root, db, codexHome } = bureau(t);
  assert.equal(lireFicheCodex(db, "hal-test"), null);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  const lue = lireFicheCodex(db, "hal-test");
  assert.equal(lue.thread_id, "thread-1");
  assert.deepEqual(lue.peer, { id: "hal-test", status: "active", instance_session_id: "thread-1", house: codexHome, pid: process.pid, last_seen: T0, dead_at: null });
  fs.writeFileSync(path.join(root, "codex", "bob.json"), "{ pas du json");
  assert.equal(lireFicheCodex(db, "bob"), null, "une fiche illisible n'est pas une fiche");
  fs.writeFileSync(path.join(root, "codex", "carol.json"), JSON.stringify({ lineage: "hal-test", thread_id: "thread-9" }));
  assert.equal(lireFicheCodex(db, "carol"), null, "une fiche qui nomme une autre lignée que son nom de fichier ne vaut rien");
  assert.equal(lireFicheCodex(db, ""), null);
});

test("rafraichirFicheCodex : last_seen avance, le fil et started_at restent, la carte bat et ressuscite ; sans fiche, null", (t) => {
  const { db, codexHome } = bureau(t);
  assert.equal(rafraichirFicheCodex(db, "hal-test", { now: T1 }), null);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  db.prepare("UPDATE peers SET status = 'offline', dead_at = ? WHERE id = 'hal-test'").run(T0);
  const fiche = rafraichirFicheCodex(db, "hal-test", { now: T1 });
  assert.equal(fiche.last_seen, T1);
  assert.equal(fiche.started_at, T0);
  assert.equal(fiche.thread_id, "thread-1");
  assert.equal(fiche.dead_at, null);
  assert.equal(Object.hasOwn(fiche, "peer"), false, "la fiche écrite ne porte pas le résumé de la carte");
  assert.deepEqual(JSON.parse(fs.readFileSync(cheminDeLaFiche("hal-test"), "utf8")), fiche);
  const row = db.prepare("SELECT status, last_seen, heartbeat_at, dead_at FROM peers WHERE id = 'hal-test'").get();
  assert.deepEqual(row, { status: "active", last_seen: T1, heartbeat_at: T1, dead_at: null }, "se ré-annoncer, c'est ressusciter (Camp B)");
});

test("ecrireFicheCodex sur le même fil garde started_at ; sur un autre fil, la fiche repart et la carte suit", (t) => {
  const { db, codexHome } = bureau(t);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  const meme = ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, porte: "app", now: T1 });
  assert.equal(meme.started_at, T0);
  assert.equal(meme.last_seen, T1);
  assert.equal(meme.porte, "app");
  assert.deepEqual(JSON.parse(db.prepare("SELECT metadata_json FROM peers WHERE id = 'hal-test'").get().metadata_json).porte, "app");
  const autre = ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-2", codex_home: codexHome, pid: process.pid, now: T1 });
  assert.equal(autre.started_at, T1);
  assert.equal(db.prepare("SELECT instance_session_id FROM peers WHERE id = 'hal-test'").get().instance_session_id, "thread-2");
  assert.equal(resolveRecipient(db, "hal-test").targets[0].instance_session_id, "thread-2");
});

test("fichesCodex : toutes les fiches lisibles, triées, chacune avec sa carte ; un dossier absent rend [] ; le registre des lignées voit les chaises Codex", (t) => {
  const { root, db, codexHome } = bureau(t);
  assert.deepEqual(fichesCodex(db), []);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  ecrireFicheCodex(db, { lineage: "bob", thread_id: "thread-b", codex_home: codexHome, pid: process.pid, porte: "exec", now: T0 });
  fs.writeFileSync(path.join(root, "codex", "carol.json"), "{");
  fs.writeFileSync(path.join(root, "codex", "hal-test.json.tmp.1.2"), "{}");
  assert.deepEqual(
    fichesCodex(db).map((f) => [f.lineage, f.thread_id, f.porte, f.peer?.status]),
    [["bob", "thread-b", "exec", "active"], ["hal-test", "thread-1", "cli", "active"]]
  );
  assert.deepEqual(
    listLineages(db).map((l) => [l.lineage, l.chaises, l.kind]),
    [["bob", 1, "instance"], ["hal-test", 1, "instance"]]
  );
});

test("les refus : lignée ou fil manquant, porte inconnue, pid implausible — et rien n'est écrit", (t) => {
  const { root, db, codexHome } = bureau(t);
  assert.throws(() => ecrireFicheCodex(db, { lineage: "", thread_id: "t", codex_home: codexHome, pid: process.pid }), /requires a lineage/);
  assert.throws(() => ecrireFicheCodex(db, { lineage: "hal-test", thread_id: " ", codex_home: codexHome, pid: process.pid }), /requires a thread_id/);
  assert.throws(() => ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "t", codex_home: codexHome, pid: process.pid, porte: "tui" }), /unknown door "tui"/);
  assert.throws(() => ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "t", codex_home: codexHome, pid: 0 }), /requires the pid/);
  assert.equal(fs.existsSync(path.join(root, "codex")), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers").get().n, 0);
  assert.deepEqual(PORTES_CODEX, ["cli", "app", "exec"]);
});

test("codexHomeDe et porteDeLEnvironnement : CODEX_HOME absolu, sinon ~/.codex ; VALXOS_CODEX_PORTE connue, absente app (round 1 de la Tâche 11), inconnue cli", () => {
  assert.equal(codexHomeDe({ HOME: "/home/office-test", CODEX_HOME: "/x/codex" }), "/x/codex");
  assert.equal(codexHomeDe({ HOME: "/home/office-test", CODEX_HOME: "relative/codex" }), "/home/office-test/.codex", "un chemin relatif ne désigne rien");
  assert.equal(codexHomeDe({ HOME: "/home/office-test" }), "/home/office-test/.codex");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "app" }), "app");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "cli" }), "cli");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "exec" }), "exec");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "TUI" }), "cli", "une porte inconnue : le côté sûr, l'app ne s'ouvre pas");
  assert.equal(porteDeLEnvironnement({}), "app", "absente : l'app de bureau n'a pas de lanceur ; un terminal pose cli");
  assert.equal(porteDeLEnvironnement({ VALXOS_CODEX_PORTE: "  " }), "app", "vide compte pour absente");
});

// ── Les durcissements de l'implémentation (au-delà du brief) ───────────────
test("refus — une lignée qui n'est pas un nom nu (lignée#fil, lignée@nom) et un codex_home relatif : rien n'est écrit, et le refus ne nomme pas la lignée", (t) => {
  const { root, db, codexHome } = bureau(t);
  for (const lineage of ["hal-test#thread-1", "hal-test@atelier", "-hal-test"]) {
    assert.throws(
      () => ecrireFicheCodex(db, { lineage, thread_id: "t", codex_home: codexHome, pid: process.pid }),
      (erreur) => /requires a lineage that is a bare name/.test(erreur.message) && !erreur.message.includes("hal-test"),
      lineage
    );
  }
  assert.throws(() => ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "t", codex_home: "relative/codex", pid: process.pid }), /requires an absolute codex_home/);
  assert.equal(fs.existsSync(path.join(root, "codex")), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM peers").get().n, 0);
});

test("proc_start : celui du pid de la fiche, jamais une naissance héritée d'un autre pid (la moisson condamnerait une chaise vivante)", (t) => {
  const { db, codexHome } = bureau(t);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  db.prepare("UPDATE peers SET proc_start = 'Thu Jan  1 00:00:00 1970' WHERE id = 'hal-test'").run();
  // Un pid parti : `ps` ne lui connaît pas de naissance. La carte ne garde pas celle d'avant.
  const parti = spawnSync(process.execPath, ["-e", ""]).pid;
  const fiche = ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: parti, now: T1 });
  assert.equal(fiche.proc_start, null, "ps ne connaît pas un pid parti");
  const carte = db.prepare("SELECT pid, proc_start FROM peers WHERE id = 'hal-test'").get();
  assert.deepEqual(carte, { pid: parti, proc_start: null }, "la carte dit la naissance de la fiche, pas celle d'un autre pid");
});

test("rafraichirFicheCodex sans carte (un broker.db neuf dans le même bureau) : null, et la fiche n'est pas touchée — l'appelant la réécrit", (t) => {
  const { db, codexHome } = bureau(t);
  const ecrite = ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  db.prepare("DELETE FROM peers WHERE id = 'hal-test'").run(); // la base jetable d'un test, jamais le code
  assert.equal(rafraichirFicheCodex(db, "hal-test", { now: T1 }), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(cheminDeLaFiche("hal-test"), "utf8")), ecrite, "last_seen n'avance pas sur une fiche sans carte");
});

test("fichesCodex et lireFicheCodex : une fiche qui nomme une autre lignée que son nom de fichier ne compte pas", (t) => {
  const { root, db, codexHome } = bureau(t);
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: T0 });
  fs.writeFileSync(path.join(root, "codex", "carol.json"), JSON.stringify({ lineage: "hal-test", thread_id: "thread-9" }));
  assert.deepEqual(fichesCodex(db).map((f) => [f.lineage, f.thread_id]), [["hal-test", "thread-1"]]);
});

// ── Round 1 de la Tâche 11 : la moisson Codex lit proc_start ────────────────
// `isProcessAlive(pid)` seul prenait un pid RECYCLÉ (un autre processus né sous
// le même numéro) pour la chaise vivante : jamais moissonnée, et le médecin
// disait `pid_vivant: true`. La fiche porte `proc_start` pour ce cas-là — la
// règle de `verdictDeChaise` (registry.js) : une naissance connue qui diffère,
// c'est parti ; `ps` muet ou naissance inconnue, on ne condamne pas.
test("round 1 — moissonnerLesFichesCodex lit proc_start : un pid vivant mais recyclé est parti ; ps muet ou naissance inconnue, vivant", (t) => {
  const { root, db, codexHome } = bureau(t);
  const ilYa25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: ilYa25h });
  const fichier = path.join(root, "codex", "hal-test.json");
  const posee = JSON.parse(fs.readFileSync(fichier, "utf8"));
  const avecNaissance = (proc_start) => fs.writeFileSync(fichier, `${JSON.stringify({ ...posee, proc_start })}\n`, { mode: 0o600 });
  const vivant = () => true;
  const candidates = (naissance) => moissonnerLesFichesCodex(db, { dryRun: true, vivant, naissance }).reaped.map((r) => [r.lineage, r.processus]);

  avecNaissance("Wed Oct 21 09:00:00 2026");
  assert.deepEqual(candidates(() => "Tue Oct 20 08:00:00 2026"), [["hal-test", "pid-recycle"]]);
  assert.deepEqual(candidates(() => "Wed Oct 21  09:00:00 2026"), [], "la même naissance, aux espaces près : vivante");
  assert.deepEqual(candidates(() => null), [], "ps muet : on ne condamne pas");
  avecNaissance(null);
  assert.deepEqual(candidates(() => "Tue Oct 20 08:00:00 2026"), [], "naissance inconnue : on ne condamne pas");
  assert.equal(processusDeLaFiche({ pid: process.pid, proc_start: "a" }, { vivant, naissance: () => "b" }), "pid-recycle");
  assert.equal(processusDeLaFiche({ pid: process.pid, proc_start: "a" }, { vivant: () => false, naissance: () => "a" }), "parti");
  assert.equal(processusDeLaFiche({ pid: process.pid, proc_start: "a" }, { vivant, naissance: () => "a" }), "vivant");

  avecNaissance("Wed Oct 21 09:00:00 2026");
  const moisson = moissonnerLesFichesCodex(db, { vivant, naissance: () => "Tue Oct 20 08:00:00 2026" });
  assert.deepEqual(moisson.reaped.map((r) => [r.lineage, r.processus]), [["hal-test", "pid-recycle"]]);
  assert.match(String(JSON.parse(fs.readFileSync(fichier, "utf8")).dead_at), /^\d{4}-/);
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = 'hal-test'").get().status, "dead");
  const trace = db.prepare("SELECT detail_json FROM delivery_events WHERE event_type = 'peer_reaped' AND agent_id = 'hal-test'").get();
  assert.deepEqual([JSON.parse(trace.detail_json).raison, JSON.parse(trace.detail_json).processus], ["codex-parti-24h", "pid-recycle"]);
});

test("round 1 — une chaise rafraîchie pendant la moisson n'est pas condamnée sur sa vue d'avant (relue dans la transaction)", (t) => {
  const { root, db, codexHome } = bureau(t);
  const ilYa25h = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  ecrireFicheCodex(db, { lineage: "hal-test", thread_id: "thread-1", codex_home: codexHome, pid: process.pid, now: ilYa25h });
  // Le hook de la chaise passe ENTRE le constat et l'écriture : c'est sa vue qui gagne.
  const moisson = moissonnerLesFichesCodex(db, {
    vivant: () => {
      rafraichirFicheCodex(db, "hal-test");
      return false;
    }
  });
  assert.deepEqual(moisson.reaped, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "codex", "hal-test.json"), "utf8")).dead_at, null);
  assert.equal(db.prepare("SELECT status FROM peers WHERE id = 'hal-test'").get().status, "active");
});
