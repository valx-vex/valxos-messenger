// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { insertMessage, openDatabase } from "../src/lib/database.js";
import { cleDeRefus, deciderLaChaise, deciderLaCopie } from "../src/lib/identity.js";
import { designatePrimary, registerInstance } from "../src/lib/registry.js";
import { procStartOf } from "../src/lib/postbox.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-monitor-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timeout waiting for condition"));
      }
    }, 50);
  });
}

// ⚠️ UN TEST ROUGE NE PEND PAS LE FICHIER (Run 6, 27/09). Ce test lançait son
// moniteur sans `t.after` : au premier `waitFor` échoué, l'enfant python
// restait vivant, ses tuyaux tenaient la boucle d'événements, et le fichier
// entier attendait le plafond de la suite (900 s mesurées) au lieu de rougir
// en 5 s. Il passe maintenant par `startMonitor`, qui tue l'orphelin.
test("monitor wakes on Unix socket, prints event, and removes socket on SIGTERM", { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-monitor-"));
  const socketPath = path.join(root, "run", "monitor-agent.sock");
  const { child, out } = startMonitor(t, root, "monitor-agent");
  const stdout = () => out.stdout;

  await waitFor(() => fs.existsSync(socketPath));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, {
    sender: "bob-opus",
    recipient: "monitor-agent",
    body: "socket hello"
  });
  db.close();

  await new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath }, () => {
      client.end("wake\n");
      resolve();
    });
    client.on("error", reject);
  });

  await waitFor(() => stdout().includes("socket hello"));
  await stopMonitor(child);
  assert.match(stdout(), /CC2CC_EVENT/);
  assert.equal(fs.existsSync(socketPath), false);
});

// --- Propriete du socket (correctif A) ---------------------------------

// LA SÉANCE D'UN MONITEUR (Run 6, Task 6). Le moniteur ne relève plus que le
// courrier de SA session : il la trouve à la fiche de session de son parent
// (ce runner), et sa chaise doit être au registre sous ce pid. Chaque moniteur
// de test reçoit donc une maison jetable (jamais la maison du lanceur) avec
// une fiche au numéro de ce runner, et une chaise inscrite pour sa lignée.
function seanceDuMoniteur(root, agentId, sessionId = `sess-${agentId}`) {
  const h = path.join(root, "maison");
  fs.mkdirSync(path.join(h, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId }));
  inscrireChaise(root, agentId, sessionId, process.pid);
  return h;
}

function inscrireChaise(root, lineage, sessionId, pid, procStart = null) {
  const previous = process.env.CC2CC_V2_HOME;
  poserLeBureau(root);
  try {
    const db = openDatabase({ file: path.join(root, "broker.db") });
    registerInstance(db, { lineage, sessionId, pid, procStart });
    db.close();
  } finally {
    if (previous === undefined) delete process.env.CC2CC_V2_HOME;
    else process.env.CC2CC_V2_HOME = previous;
  }
}

function startMonitor(t, root, agentId) {
  const maisonDuMoniteur = seanceDuMoniteur(root, agentId);
  const child = spawn("python3", [path.join(repo, "src/monitor/valxos_monitor.py")], {
    env: {
      ...envPropre(),
      CC2CC_V2_HOME: root,
      CC2CC_SELF: agentId,
      CLAUDE_CONFIG_DIR: maisonDuMoniteur
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const out = { stdout: "", stderr: "", exit: undefined };
  child.stdout.on("data", (chunk) => {
    out.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    out.stderr += chunk.toString();
  });
  child.once("exit", (code) => {
    out.exit = code;
  });
  // Un test qui echoue ne doit jamais laisser un moniteur orphelin derriere lui.
  t.after(async () => {
    if (out.exit !== undefined) return;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  });
  return { child, out };
}

async function stopMonitor(child) {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

function pokeSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath }, () => {
      client.end("wake\n");
      resolve();
    });
    client.on("error", reject);
  });
}

function monitorRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-monitor-"));
}

function insertInto(root, recipient, body) {
  const previous = process.env.CC2CC_V2_HOME;
  poserLeBureau(root);
  try {
    const db = openDatabase({ file: path.join(root, "broker.db") });
    insertMessage(db, { sender: "bob-opus", recipient, body });
    db.close();
  } finally {
    if (previous === undefined) delete process.env.CC2CC_V2_HOME;
    else process.env.CC2CC_V2_HOME = previous;
  }
}

test("a second monitor for the same identity refuses to start while the first one lives", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const socketPath = path.join(root, "run", "twin-agent.sock");

  const first = startMonitor(t, root, "twin-agent");
  await waitFor(() => fs.existsSync(socketPath));
  const firstInode = fs.statSync(socketPath).ino;

  const second = startMonitor(t, root, "twin-agent");
  await waitFor(() => second.out.exit !== undefined);
  assert.notEqual(second.out.exit, 0);
  assert.match(second.out.stderr, /twin-agent/);
  // Le refus poli DIT qu'il est poli : comportement voulu, pas une panne,
  // et la fenetre sait qu'elle reste servie (dette E, retour d'un pair, 18/08).
  assert.match(second.out.stderr, /POLITE REFUSAL/);
  assert.match(second.out.stderr, /intended behaviour, not a failure/);
  assert.match(second.out.stderr, /the Facteur keeps serving this session/);

  // Le socket du premier est intact: meme fichier, meme inode.
  assert.equal(fs.existsSync(socketPath), true);
  assert.equal(fs.statSync(socketPath).ino, firstInode);

  // Et le premier repond toujours au reveil.
  insertInto(root, "twin-agent", "toujours vivant");
  await pokeSocket(socketPath);
  await waitFor(() => first.out.stdout.includes("toujours vivant"));

  await stopMonitor(first.child);
  assert.equal(fs.existsSync(socketPath), false);

  // Une fois le premier parti, un nouveau moniteur prend la place.
  const third = startMonitor(t, root, "twin-agent");
  await waitFor(() => fs.existsSync(socketPath));
  await stopMonitor(third.child);
});

test("monitor replaces an orphan socket nobody listens on", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const runDir = path.join(root, "run");
  fs.mkdirSync(runDir, { recursive: true });
  const socketPath = path.join(runDir, "orphan-agent.sock");

  // Un vrai socket unix abandonne: bind puis _exit sans unlink.
  const leftover = spawnSync("python3", [
    "-c",
    [
      "import os, socket, sys",
      "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
      "s.bind(sys.argv[1])",
      "s.listen(1)",
      "os._exit(0)"
    ].join("\n"),
    socketPath
  ]);
  assert.equal(leftover.status, 0);
  assert.equal(fs.existsSync(socketPath), true);

  const monitor = startMonitor(t, root, "orphan-agent");
  // ⚠️ PAS « UN INODE NEUF » (Run 6, 27/09) : sous Linux, le numéro d'inode
  // libéré par l'unlink de l'orphelin est RÉUTILISÉ tout de suite par le bind
  // du moniteur — la CI attendait un changement qui n'arrive jamais (timeout
  // à 5 s, rouge sur main). Ce qui fait foi, c'est ce que le moniteur DIT :
  // il a remplacé l'orphelin, puis il a démarré, lui, avec ce PID.
  const journal = path.join(root, "logs", "orphan-agent.log");
  const lignes = () => {
    if (!fs.existsSync(journal)) return [];
    return fs.readFileSync(journal, "utf8").split("\n").flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; } // ligne vide ou en cours d'écriture
    });
  };
  await waitFor(() => lignes().some((l) => l.message === "monitor started" && l.pid === monitor.child.pid));
  const messages = lignes().map((l) => l.message);
  assert.ok(messages.indexOf("orphan socket replaced") >= 0, `l'orphelin est nommé au journal : ${messages.join(", ")}`);
  assert.ok(messages.indexOf("orphan socket replaced") < messages.indexOf("monitor started"), "remplacé AVANT le démarrage");
  assert.equal(lignes().find((l) => l.message === "monitor started").inode, fs.statSync(socketPath).ino, "le socket présent est celui que le moniteur a lié");

  insertInto(root, "orphan-agent", "socket recycle");
  await pokeSocket(socketPath);
  await waitFor(() => monitor.out.stdout.includes("socket recycle"));

  await stopMonitor(monitor.child);
  assert.equal(monitor.out.exit, 0);
});

test("monitor never unlinks a socket file it did not create", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const socketPath = path.join(root, "run", "usurped-agent.sock");

  const monitor = startMonitor(t, root, "usurped-agent");
  await waitFor(() => fs.existsSync(socketPath));

  // Quelqu'un remplace le fichier sous les pieds du moniteur.
  fs.unlinkSync(socketPath);
  fs.writeFileSync(socketPath, "usurper", "utf8");
  const usurperInode = fs.statSync(socketPath).ino;

  await stopMonitor(monitor.child);

  assert.equal(fs.existsSync(socketPath), true);
  assert.equal(fs.statSync(socketPath).ino, usurperInode);
  assert.equal(fs.readFileSync(socketPath, "utf8"), "usurper");
});

test("une panne de bind qui n'est PAS un frère vivant ne se déguise pas en refus", () => {
  // Un chemin trop long pour AF_UNIX (~104 octets sur macOS). Le bind échoue,
  // mais personne ne tient le socket : le dire « déjà démarré » enverrait
  // l'opérateur chercher un moniteur qui n'existe pas, et le code 3 signifierait
  // « tout va bien, un autre tourne » — le réveil serait mort en silence.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-long-"));
  const root = path.join(base, "e".repeat(90));
  fs.mkdirSync(root, { recursive: true });

  const fini = spawnSync("python3", [path.join(repo, "src/monitor/valxos_monitor.py")], {
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "monitor-long" },
    encoding: "utf8",
    timeout: 15000
  });

  const trace = `${fini.stdout || ""}${fini.stderr || ""}`;
  // Sonde à trois issues : si le chemin passait malgré tout, ce test ne
  // prouverait rien — on le dit au lieu de le compter comme un succès.
  assert.ok(/too long/i.test(trace), `sonde impossible : le bind n'a pas échoué comme prévu — ${trace}`);
  assert.notEqual(fini.status, 3, "un chemin trop long n'est pas un frère vivant");
  assert.ok(!/a pris/.test(trace), `le message accuse un moniteur inexistant : ${trace}`);
});

// Le forensique du 18/08 a coûté une matinée parce que le moniteur ne disait
// jamais qu'il DÉMARRAIT : 132 lignes de log, toutes « monitor stopped », et
// aucun moyen de savoir quel PID tenait quel socket. Une ligne au démarrage
// — pid, socket, inode — et la moitié de l'enquête devient un grep.
test("monitor logs its start with pid, socket path and inode", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const socketPath = path.join(root, "run", "starter.sock");
  const { child } = startMonitor(t, root, "starter");
  await waitFor(() => fs.existsSync(socketPath));
  await waitFor(() => fs.existsSync(path.join(root, "logs", "starter.log")));
  const inode = fs.statSync(socketPath).ino;

  const lignes = fs.readFileSync(path.join(root, "logs", "starter.log"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const start = lignes.find((l) => l.message === "monitor started");
  assert.ok(start, `pas de ligne « monitor started » : ${JSON.stringify(lignes)}`);
  assert.equal(start.pid, child.pid, "la ligne porte le PID du moniteur");
  assert.equal(start.socket, socketPath, "et le chemin du socket qu'il tient");
  assert.equal(start.inode, inode, "et l'inode qui fait foi à l'arrêt");

  await stopMonitor(child);
});

// F3 (passe adverse, 18/08) : entre le bind() de A et son listen(), un
// frère B qui sonde voit ECONNREFUSED, croit à un orphelin, et prend le socket.
// Ce n'est pas B le problème (il a raison de prendre un socket que personne
// n'écoute) : c'est A, qui continuerait en FANTÔME et, pire, mémoriserait
// l'inode de B pour l'effacer à sa sortie. A doit constater le vol et se
// retirer proprement — sans toucher au socket de B.
test("un moniteur dont le socket est pris entre bind et listen se retire sans rien effacer", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const socketPath = path.join(root, "run", "twins.sock");
  // A s'attarde 1,5 s entre bind et listen (crochet de test, jamais posé en prod).
  const a = spawn("python3", [path.join(repo, "src/monitor/valxos_monitor.py")], {
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "twins", CC2CC_MONITOR_DEBUG_PAUSE_AFTER_BIND_MS: "1500" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const aOut = { stderr: "", exit: undefined };
  a.stderr.on("data", (c) => { aOut.stderr += c.toString(); });
  a.once("exit", (code) => { aOut.exit = code; });
  t.after(async () => { if (aOut.exit === undefined) { a.kill("SIGKILL"); await new Promise((r) => a.once("exit", r)); } });

  await waitFor(() => fs.existsSync(socketPath));          // A a bindé, pas encore listen
  const b = startMonitor(t, root, "twins");                // B sonde : refus → orphelin → prend
  await waitFor(() => aOut.exit !== undefined, 10000);     // A doit se retirer tout seul

  assert.equal(aOut.exit, 3, `A doit sortir 3 (frère vivant), stderr: ${aOut.stderr}`);
  assert.match(aOut.stderr, /during startup/);
  assert.ok(fs.existsSync(socketPath), "le socket de B est toujours là : A n'a rien effacé");
  const inodeB = fs.statSync(socketPath).ino;
  const lignes = fs.readFileSync(path.join(root, "logs", "twins.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const started = lignes.filter((l) => l.message === "monitor started");
  assert.equal(started.length, 1, "un seul « monitor started » : B");
  assert.equal(started[0].pid, b.child.pid);
  assert.equal(started[0].inode, inodeB);
  assert.equal(fs.readFileSync(path.join(root, "run", "twins.pid"), "utf8").trim(), String(b.child.pid), "le .pid est celui de B");

  await stopMonitor(b.child);
  assert.ok(!fs.existsSync(socketPath), "à l'arrêt propre de B, son socket disparaît (il est à lui)");
});

// ── LA CHAISE RÉCEPTRICE, CÔTÉ MONITEUR (Run 6, Task 6, 27/09) ──────────────
// Une SEULE règle de décision, écrite en Node (`deciderLaChaise`) et reflétée
// en Python (`decider_la_chaise`). Ce tableau est joué des deux côtés : un
// écart, c'est un moniteur qui sert une lettre que les hooks refusent.
const CAS_DE_CHAISE = [
  { agentId: "a1", sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 10, etat: "vivante", raison: "meme-incarnation" } },
  { agentId: "a1", sessionId: null, ficheSessionId: null, pid: 10, chaise: null },
  { agentId: null, sessionId: null, ficheSessionId: null, pid: 10, chaise: null },
  { agentId: null, sessionId: "", ficheSessionId: "S", pid: 10, chaise: null },
  { agentId: null, sessionId: "S", ficheSessionId: "AUTRE", pid: 10, chaise: { pid: 10, etat: "vivante", raison: "meme-incarnation" } },
  { agentId: null, sessionId: "S", ficheSessionId: null, pid: 10, chaise: null },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 10, etat: "vivante", raison: "meme-incarnation" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: "10", etat: "vivante", raison: "meme-incarnation" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "vivante", raison: "meme-incarnation" } },
  { agentId: null, sessionId: "S", ficheSessionId: null, pid: 10, chaise: { pid: 11, etat: "vivante", raison: "meme-incarnation" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "morte", raison: "pid-recycle" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "indecidable", raison: "sonde-impossible" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: null, etat: "indecidable", raison: "sans-pid" } },
  { agentId: "", sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "vivante", raison: "meme-incarnation" } },
  // Fix 1 : l'optimiste « pid-vivant » (rien d'inscrit) ne retient JAMAIS personne.
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "vivante", raison: "pid-vivant" } },
  { agentId: null, sessionId: "S", ficheSessionId: null, pid: 10, chaise: { pid: 11, etat: "vivante" } },
  { agentId: null, sessionId: "S", ficheSessionId: "S", pid: 10, chaise: { pid: 11, etat: "morte", raison: "processus-parti" } }
];

test("27/09 — PARITÉ : la règle de la chaise rend le même verdict en Node et en Python", () => {
  const attendu = CAS_DE_CHAISE.map((cas) => deciderLaChaise(cas));
  const py = spawnSync("python3", ["-B", "-c", [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repo, "src/monitor"))})`,
    "import valxos_monitor as m",
    "cas = json.loads(sys.stdin.read())",
    "print(json.dumps([m.decider_la_chaise(c['agentId'], c['sessionId'], c['ficheSessionId'], c['pid'], c['chaise']) for c in cas]))"
  ].join("\n")], { input: JSON.stringify(CAS_DE_CHAISE), encoding: "utf8", env: envPropre() });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), attendu);
  // Et les verdicts eux-mêmes, pour qu'une dérive COMMUNE aux deux côtés rougisse aussi.
  assert.deepEqual(attendu.map((v) => v.raison), [
    "sous-agent", "sous-agent", "sans-session", "sans-session", "fiche-d-une-autre-session", "chaise",
    "chaise", "chaise", "jumeau", "jumeau", "chaise", "chaise", "chaise", "jumeau",
    "chaise", "chaise", "chaise"
  ]);
  assert.deepEqual(attendu.map((v) => v.recoit), [
    false, false, true, true, false, true, true, true, false, false, true, true, true, false,
    true, true, true
  ]);
});

function evenements(stdout) {
  return stdout.split("\n").filter((l) => l.startsWith("CC2CC_EVENT ")).map((l) => JSON.parse(l.slice("CC2CC_EVENT ".length)));
}

function drainerUneFois(root, maisonDuMoniteur, self) {
  return spawnSync("python3", ["-B", "-c", [
    "import sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repo, "src/monitor"))})`,
    "import valxos_monitor as m",
    "mon = m.Monitor()",
    "mon.ensure_dirs()",
    "mon.drain()"
  ].join("\n")], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: self, CLAUDE_CONFIG_DIR: maisonDuMoniteur }
  });
}

function bureauDuMoniteur() {
  const root = monitorRoot();
  const h = path.join(root, "maison");
  fs.mkdirSync(path.join(h, "sessions"), { recursive: true });
  return { root, h };
}

function journalDuMoniteur(root, agent) {
  const f = path.join(root, "logs", `${agent}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("27/09 — le moniteur ne relève que SA chaise, et la lignée seulement quand elle lui revient", () => {
  const { root, h } = bureauDuMoniteur();
  const previous = process.env.CC2CC_V2_HOME;
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    registerInstance(db, { lineage: "L", sessionId: "S1", pid: process.pid });
    registerInstance(db, { lineage: "L", sessionId: "S2", pid: process.pid });
    designatePrimary(db, "L", "S1");
    insertMessage(db, { sender: "bob-eternal", recipient: "L", body: "lettre-de-lignee" });
    insertMessage(db, { sender: "bob-eternal", recipient: "L#S2", body: "lettre-nominative" });
    insertMessage(db, { sender: "bob-eternal", recipient: "L#S1", body: "lettre-du-voisin" });
  } finally {
    if (previous === undefined) delete process.env.CC2CC_V2_HOME;
    else process.env.CC2CC_V2_HOME = previous;
  }
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S2" }));

  const premier = drainerUneFois(root, h, "L");
  assert.equal(premier.status, 0, premier.stderr);
  assert.match(premier.stdout, /lettre-nominative/);
  // Task 7 : S2 VOIT la lettre de la lignée — en copie cc, jamais comme sienne.
  const lignee = evenements(premier.stdout).filter((e) => e.body === "lettre-de-lignee");
  assert.equal(lignee.length, 1);
  assert.equal(lignee[0].cc, true, "S1 est désignée : la lignée n'est pas à S2, S2 n'en a qu'une copie");
  assert.doesNotMatch(premier.stdout, /lettre-du-voisin/);

  designatePrimary(db, "L", "S2");
  db.close();
  const second = drainerUneFois(root, h, "L");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /lettre-de-lignee/, "désignée, S2 reçoit la lignée");
  assert.doesNotMatch(second.stdout, /lettre-du-voisin/);
});

test("27/09 — un moniteur JUMEAU (sa session tenue par un autre pid vivant) ne relève rien, et le dit une fois", () => {
  const { root, h } = bureauDuMoniteur();
  // La chaise est tenue par le parent de ce runner : vivant, pas le nôtre, et
  // CONFIRMÉ (son heure de naissance inscrite est la sienne).
  inscrireChaise(root, "L", "S2", process.ppid, procStartOf(process.ppid));
  insertInto(root, "L#S2", "pas-pour-le-jumeau");
  insertInto(root, "L", "lignee-pas-pour-le-jumeau");
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S2" }));
  for (let i = 0; i < 2; i += 1) {
    const r = drainerUneFois(root, h, "L");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /pour-le-jumeau/);
  }
  const refus = journalDuMoniteur(root, "L").filter((l) => l.message === "chaise_refusee");
  assert.equal(refus.length, 1, "un refus journalisé une fois, pas à chaque relève");
  assert.equal(refus[0].raison, "jumeau");
  assert.equal(refus[0].session_id, "S2");
});

test("27/09 — un moniteur sans session connue ne relève AUCUN courrier de lignée, et le dit une fois", () => {
  const { root, h } = bureauDuMoniteur();
  insertInto(root, "L", "lignee-orpheline");
  for (let i = 0; i < 2; i += 1) {
    const r = drainerUneFois(root, h, "L");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /lignee-orpheline/);
  }
  const lignes = journalDuMoniteur(root, "L").filter((l) => l.message === "unknown session: no lineage mail");
  assert.equal(lignes.length, 1);
});

test("27/09 — PARITÉ : la marque « refus dit une fois » a la même clef en Node et en Python", () => {
  const cas = [
    { raison: "jumeau", sessionId: "S2", agentId: null, pid: 4242 },
    { raison: "sous-agent", sessionId: "S", agentId: "a1", pid: 7 },
    { raison: "session-inconnue", sessionId: null, agentId: null, pid: null }
  ];
  const py = spawnSync("python3", ["-B", "-c", [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repo, "src/monitor"))})`,
    "import valxos_monitor as m",
    "cas = json.loads(sys.stdin.read())",
    "print(json.dumps([m.cle_de_refus(c['raison'], c['sessionId'], c['agentId'], c['pid']) for c in cas]))"
  ].join("\n")], { input: JSON.stringify(cas), encoding: "utf8", env: envPropre() });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), cas.map((c) => cleDeRefus(c)));
});

test("27/09 fix 1 — une chaise NON CONFIRMÉE (pid vivant, aucune naissance inscrite) ne fait pas du moniteur un jumeau", () => {
  const { root, h } = bureauDuMoniteur();
  inscrireChaise(root, "L", "S2", process.ppid);
  insertInto(root, "L#S2", "reprise-pour-de-bon");
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S2" }));
  const r = drainerUneFois(root, h, "L");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reprise-pour-de-bon/);
  assert.equal(journalDuMoniteur(root, "L").filter((l) => l.message === "chaise_refusee").length, 0);
});

// ── LA COPIE CC (Run 6, Task 7) — même règle des deux côtés ────────────────
const CHAISE = (session, lineage = "L") => ({ id: `${lineage}#${session}`, instance_session_id: session, lineage });
const CAS_DE_COPIE = [
  { lignee: "L", sessionId: "S2", resolution: { kind: "lineage", targets: [CHAISE("S2")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "lineage", targets: [CHAISE("S1")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "ambigu", targets: [CHAISE("S1"), CHAISE("S2")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "unknown", targets: [] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "instance", targets: [CHAISE("S1")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "lineage", targets: [CHAISE("S1", "AILLEURS")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "ambigu", targets: [CHAISE("S1", "AILLEURS"), CHAISE("S3", "AILLEURS")] } },
  { lignee: "L", sessionId: null, resolution: { kind: "lineage", targets: [CHAISE("S1")] } },
  { lignee: "L", sessionId: "S2", resolution: { kind: "ambigu", targets: [] } },
  { lignee: "", sessionId: "S2", resolution: { kind: "lineage", targets: [CHAISE("S1")] } }
];

test("27/09 — PARITÉ : la règle de la copie cc rend le même verdict en Node et en Python", () => {
  const attendu = CAS_DE_COPIE.map((cas) => deciderLaCopie(cas));
  const py = spawnSync("python3", ["-B", "-c", [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(path.join(repo, "src/monitor"))})`,
    "import valxos_monitor as m",
    "cas = json.loads(sys.stdin.read())",
    "print(json.dumps([m.decider_la_copie(c['lignee'], c['sessionId'], c['resolution']) for c in cas]))"
  ].join("\n")], { input: JSON.stringify(CAS_DE_COPIE), encoding: "utf8", env: envPropre() });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), attendu);
  assert.deepEqual(attendu.map((v) => v.raison), [
    "destinataire", "cc", "sans-chaise-designee", "hors-lignee", "hors-lignee",
    "hors-lignee", "hors-lignee", "sans-session", "hors-lignee", "hors-lignee"
  ]);
  assert.deepEqual(attendu.map((v) => v.copie), [false, true, true, false, false, false, false, false, false, false]);
  assert.equal(attendu[1].chaise_designee, "L#S1");
  assert.equal(attendu[2].sans_chaise_designee, true);
});

function bureauAvecChaises(sessions, designee) {
  const { root, h } = bureauDuMoniteur();
  const previous = process.env.CC2CC_V2_HOME;
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    for (const s of sessions) registerInstance(db, { lineage: "L", sessionId: s, pid: process.pid });
    if (designee) designatePrimary(db, "L", designee);
  } finally {
    if (previous === undefined) delete process.env.CC2CC_V2_HOME;
    else process.env.CC2CC_V2_HOME = previous;
  }
  return { root, h, db };
}

test("27/09 — le moniteur d'une chaise NON désignée montre la lettre de lignée en copie cc, une fois, sans la livrer", () => {
  const { root, h, db } = bureauAvecChaises(["S1", "S2"], "S1");
  insertMessage(db, { sender: "bob-eternal", recipient: "L", body: "copie-pour-S2" });
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S2" }));
  const r = drainerUneFois(root, h, "L");
  assert.equal(r.status, 0, r.stderr);
  const [copie] = evenements(r.stdout);
  assert.equal(copie.body, "copie-pour-S2");
  assert.equal(copie.cc, true);
  assert.equal(copie.chaise_designee, "L#S1");
  assert.equal(copie.sans_chaise_designee, false);
  assert.match(copie.note, /NOT addressed to this session/);
  const ligne = db.prepare("SELECT injected_at, delivered_at FROM messages WHERE body = 'copie-pour-S2'").get();
  assert.equal(ligne.injected_at, null, "une copie n'est pas une injection");
  assert.equal(ligne.delivered_at, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM delivery_events WHERE event_type = 'cc_vu' AND agent_id = 'L#S2'").get().n, 1,
    "la MÊME marque que les hooks : une copie vue par le moniteur ne se redit pas au hook");
  const encore = drainerUneFois(root, h, "L");
  assert.equal(evenements(encore.stdout).length, 0, "la copie ne se répète pas");
  db.close();
});

test("27/09 — lignée sans désignée : le moniteur montre la copie avec le drapeau sans-chaise-designee, et ne livre rien", () => {
  const { root, h, db } = bureauAvecChaises(["S1", "S2"], null);
  insertMessage(db, { sender: "bob-eternal", recipient: "L", body: "tenue-pour-la-lignee" });
  db.close();
  fs.writeFileSync(path.join(h, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S2" }));
  const r = drainerUneFois(root, h, "L");
  assert.equal(r.status, 0, r.stderr);
  const [copie] = evenements(r.stdout);
  assert.equal(copie.cc, true);
  assert.equal(copie.chaise_designee, null);
  assert.equal(copie.sans_chaise_designee, true);
});

// ── LE MONITEUR NE MOISSONNE JAMAIS (Run 6, Task 8, fix round 2) ────────────
// Processus automatique du plugin : la règle de Task 6 le lie. Une chaise au
// pid d'un enfant fini reste `active` après son démarrage, et aucune trace
// `peer_reaped` n'est posée. Une lettre livrée prouve que le démarrage est
// fini : le moniteur ne sert qu'après ce qui était sa moisson.
test("27/09 — le moniteur ne moissonne jamais au démarrage", { timeout: 30000 }, async (t) => {
  const root = monitorRoot();
  const pidFini = Number(spawnSync(process.execPath, ["-e", ""]).pid);
  inscrireChaise(root, "lignee-partie", "s-partie", pidFini);
  const socketPath = path.join(root, "run", "monitor-agent.sock");
  const { child, out } = startMonitor(t, root, "monitor-agent");
  await waitFor(() => fs.existsSync(socketPath));
  insertInto(root, "monitor-agent", "preuve que le moniteur sert");
  await pokeSocket(socketPath);
  await waitFor(() => out.stdout.includes("preuve que le moniteur sert"));
  await stopMonitor(child);

  const db = openDatabase({ file: path.join(root, "broker.db") });
  try {
    assert.equal(db.prepare("SELECT status FROM peers WHERE instance_session_id = 's-partie'").get().status, "active");
    assert.equal(db.prepare("SELECT count(*) AS n FROM delivery_events WHERE event_type = 'peer_reaped'").get().n, 0);
  } finally {
    db.close();
  }
});

// Revue finale (28/09), M2 — le moniteur ignorait `VALXOS_MAISONS` sans
// `CLAUDE_CONFIG_DIR` ; Node (`maisonsConnues`) l'honore. Même règle des deux
// côtés : les maisons déclarées, sinon les maisons par défaut.
test("M2 — sans CLAUDE_CONFIG_DIR, le moniteur cherche la fiche de session dans les maisons de VALXOS_MAISONS", () => {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-maison-declaree-"));
  fs.mkdirSync(path.join(maison, "sessions"));
  fs.writeFileSync(path.join(maison, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "S-DECLAREE" }));
  const env = { ...envPropre(), VALXOS_MAISONS: maison };
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync("python3", ["-B", "-c",
    "import importlib.util,sys,json; " +
    `s=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repoRacineMoniteur(), "src/monitor/valxos_monitor.py"))}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m);print(json.dumps(m.session_fiche_of_ancestors()))"],
  { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), [process.pid, "S-DECLAREE"]);
});

function repoRacineMoniteur() {
  return path.resolve(new URL("..", import.meta.url).pathname);
}

// A6 (revue sécurité F1, 18/10) — UN BUREAU CRÉÉ PAR LE MONITEUR A LES MODES DE
// CELUI QUE CRÉE NODE.
//
// Côté Node, `ensureRuntimeDirs` pose 0700 (config.js) et la doc promet « Created
// with mode 0700 on first use ». Le moniteur, lui, créait `mkdir(parents=True)`
// SANS mode : sous un umask 022 le bureau naissait 0755, `broker.db` 0644, le
// socket et les fiches lisibles par tout compte de la machine. Or le moniteur est
// un processus AUTOMATIQUE du plugin, lancé à l'ouverture de session, en course
// avec le hook SessionStart : quand il gagne sur un bureau neuf, tout le courrier
// de la maison est exposé et « readable by the account that owns it »
// (SECURITY.md) devient faux. Il pose maintenant 0700 sur chaque dossier et
// `umask(0o077)` en tête de `main()`, qui couvre la base, ses compagnons WAL, les
// .pid, .json, .log et le socket.
//
// L'umask 022 est IMPOSÉ à l'enfant (`sh -c 'umask 022; exec …'`) : le test ne
// dépend pas de celui du lanceur, et c'est le cas où la fuite existait.
function modeDe(chemin) {
  return fs.lstatSync(chemin).mode & 0o777;
}

function arbreDesModes(racine) {
  const vus = new Map();
  (function marcher(dossier, relatif) {
    vus.set(relatif || ".", { dossier: true, mode: modeDe(dossier) });
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const r = relatif ? path.join(relatif, entree.name) : entree.name;
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) marcher(complet, r);
      else vus.set(r, { dossier: false, mode: modeDe(complet) });
    }
  })(racine, "");
  return vus;
}

test("A6 — le bureau né du moniteur sous umask 022 : dossiers 0700, base 0600, rien de lisible par un autre compte", { timeout: 30000 }, async (t) => {
  // Des noms COURTS : le socket Unix de macOS tient en 104 octets, et le dossier temporaire
  // du système en prend déjà la moitié.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mon-modes-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bureau = path.join(base, "office");
  const agent = "modes";
  const socketPath = path.join(bureau, "run", `${agent}.sock`);
  // Une maison jetable SANS fiche de session : le moniteur ne se croit la chaise de personne
  // (il dit « session inconnue », une fois — c'est ce qui pose `run/chaises-refusees/`), et la
  // fiche d'une vraie session du lanceur ne peut pas s'y glisser.
  const maison = path.join(base, "maison");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });

  const child = spawn("sh", ["-c", 'umask 022; exec python3 "$0"', path.join(repo, "src/monitor/valxos_monitor.py")], {
    env: { ...envPropre(), CC2CC_V2_HOME: bureau, CC2CC_SELF: agent, CLAUDE_CONFIG_DIR: maison, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const fini = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await fini;
    }
  });

  // Tout ce que le moniteur crée au démarrage : socket, .pid, statut, journal, base (au premier relevé).
  // 15 s et non les 5 s par défaut : un Python qui démarre sur une machine chargée (la suite
  // rejouée en double, d'autres sessions) ne doit pas faire passer ce test pour une fuite de modes.
  await waitFor(
    () => [socketPath, path.join(bureau, "status", `${agent}.json`), path.join(bureau, "logs", `${agent}.log`), path.join(bureau, "broker.db")]
      .every((chemin) => fs.existsSync(chemin)),
    15000
  );
  await waitFor(() => fs.existsSync(path.join(bureau, "run", "chaises-refusees")), 15000);

  const modes = arbreDesModes(bureau);
  await stopMonitor(child);

  assert.equal(modes.get(".").mode, 0o700, "le dossier du bureau");
  for (const sous of ["run", "status", "logs", path.join("run", "chaises-refusees")]) {
    assert.equal(modes.get(sous)?.mode, 0o700, `${sous}/ est en 0700 (vu : ${modes.get(sous)?.mode?.toString(8)})`);
  }
  assert.equal(modes.get("broker.db").mode, 0o600, "la base est en 0600, pas 0644");
  for (const [chemin, { mode }] of modes) {
    assert.equal(mode & 0o077, 0, `${chemin} (${mode.toString(8)}) n'est lisible, écrivable ni exécutable par aucun autre compte`);
  }
  assert.ok(modes.has(path.join("run", `${agent}.sock`)), "SONDE : le socket était bien dans l'arbre mesuré");
  assert.ok(modes.has(path.join("run", `${agent}.pid`)), "SONDE : le .pid aussi");
  assert.ok(modes.has(path.join("status", `${agent}.json`)), "SONDE : la fiche de statut aussi");

  // LA PARITÉ : le même umask, le bureau que crée Node. Les dossiers que les deux créent
  // portent les mêmes modes — c'est la promesse de la doc, tenue par les deux langages.
  const bureauNode = path.join(base, "office-node");
  const urlConfig = new URL("../src/lib/config.js", import.meta.url).href;
  const parNode = spawnSync("sh", ["-c", 'umask 022; exec "$0" --input-type=module -e "$1"', process.execPath,
    `import { ensureRuntimeDirs } from ${JSON.stringify(urlConfig)}; ensureRuntimeDirs();`], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: bureauNode }
  });
  assert.equal(parNode.status, 0, parNode.stderr);
  const modesNode = arbreDesModes(bureauNode);
  for (const sous of [".", "run", "status", "logs"]) {
    assert.equal(modes.get(sous).mode, modesNode.get(sous).mode, `${sous}/ : même mode côté moniteur et côté Node`);
  }
});
