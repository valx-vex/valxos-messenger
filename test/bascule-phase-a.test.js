// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// PHASE A : ~/.valxos-messenger → ~/.cc2cc-v2, écrivain vivant.
//
// La bascule du Run 6 ne copie rien : le nouveau nom devient un LIEN vers le
// bureau historique, pendant que les anciens processus tiennent la base. Ce
// fichier est la preuve que l'opérateur cite avant de toucher le bureau vivant :
// une base, un socket, un verrou — par les deux noms, sans interruption.
//
// Une seule fonction OBSERVE (`observerLaPhaseA`) ; deux tests LISENT :
//   - le lien : chaque observation doit être celle d'un bureau partagé ;
//   - le témoin négatif : un dossier vide à la place du lien doit casser
//     CHAQUE observation. Une preuve qui passerait aussi sans le lien ne
//     prouverait rien.
//
// Racine sous /tmp : AF_UNIX plafonne le chemin d'un socket à 104 octets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { envPropre } from "./aide-env.js";
import { prendreLeVerrou } from "../src/facteur/daemon.js";

const url = (relatif) => JSON.stringify(new URL(relatif, import.meta.url).href);
const repo = path.resolve(new URL("..", import.meta.url).pathname);
const AVERTISSEMENT = "VALXOS Messenger :";

// L'ÉCRIVAIN : un processus du produit, lancé AVANT le lien, qui résout son
// bureau par `baseDir()` (donc l'historique), ouvre la base par `getDatabase()`
// et ne la lâche plus. Il écrit et relit sur commande.
const SOURCE_ECRIVAIN = `
import readline from "node:readline";
import { getDatabase, registerPeer } from ${url("../src/lib/database.js")};
import { runtimePaths } from ${url("../src/lib/config.js")};
const db = getDatabase();
db.exec("CREATE TABLE IF NOT EXISTS sonde (n INTEGER, par TEXT)");
registerPeer(db, { id: "ecrivain-ancien", pid: process.pid, session_id: "s-ancien" });
let n = 0;
const dire = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const lignes = () => db.prepare("SELECT par, count(*) AS c FROM sonde GROUP BY par ORDER BY par").all().map((r) => [r.par, r.c]);
dire({ racine: runtimePaths().root, journal: db.pragma("journal_mode", { simple: true }) });
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  if (l === "ecrire") { db.prepare("INSERT INTO sonde VALUES (?, 'ancien')").run(++n); dire({ ecrit: n }); }
  else if (l === "lire") dire({ lignes: lignes() });
});
`;

// LE SECOND PROCESSUS : né APRÈS le lien, il dit où `baseDir()` l'envoie, puis
// lit et écrit la base PAR LE CHEMIN DONNÉ (le nouveau nom) — c'est ce chemin
// que le témoin négatif remplace par un dossier nu.
const SOURCE_SONDE = `
import Database from ${JSON.stringify(path.join(repo, "node_modules/better-sqlite3/lib/index.js"))};
import path from "node:path";
import { baseDir } from ${url("../src/lib/config.js")};
const racine = process.argv[1];
const sortie = { base: baseDir() };
try {
  const db = new Database(path.join(racine, "broker.db"));
  db.pragma("busy_timeout = 3000");
  sortie.journal = db.pragma("journal_mode", { simple: true });
  sortie.avant = db.prepare("SELECT par, count(*) AS c FROM sonde GROUP BY par ORDER BY par").all().map((r) => [r.par, r.c]);
  db.prepare("INSERT INTO sonde VALUES (100, 'neuf')").run();
  sortie.ecrit = true;
  db.close();
} catch (erreur) { sortie.erreur = String(erreur.message); }
process.stdout.write(JSON.stringify(sortie));
`;

// LE SOCKET : joint par le nouveau nom, un octet aller, un octet retour.
const SOURCE_SOCKET = `
import net from "node:net";
const c = net.connect(process.argv[1]);
let recu = "";
c.on("connect", () => c.write("A"));
c.on("data", (b) => { recu += b; c.end(); });
c.on("close", () => process.stdout.write(JSON.stringify({ recu })));
c.on("error", (e) => { process.stdout.write(JSON.stringify({ erreur: e.code })); process.exit(0); });
`;

// LE VERROU : un second Facteur, un autre processus, tente de le prendre par
// le nouveau nom. `cheminDuVerrou()` dit où le produit le chercherait.
const SOURCE_VERROU = `
import path from "node:path";
import { cheminDuVerrou, prendreLeVerrou } from ${url("../src/facteur/daemon.js")};
const jeton = prendreLeVerrou(path.join(process.argv[1], "run", "facteur.verrou"));
process.stdout.write(JSON.stringify({ chemin: cheminDuVerrou(), pris: Boolean(jeton) }));
`;

function lancer(source, args, home) {
  return lancerNode(["--input-type=module", "-e", source, ...args], home);
}

function lancerNode(argv, home) {
  return new Promise((ok, ko) => {
    const enfant = spawn(process.execPath, argv, {
      env: envPropre({ HOME: home }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    enfant.stdout.on("data", (b) => { stdout += b; });
    enfant.stderr.on("data", (b) => { stderr += b; });
    enfant.on("error", ko);
    enfant.on("close", (code) => ok({ code, stdout, stderr }));
  });
}

function jsonDe(resultat, quoi) {
  try {
    return JSON.parse(resultat.stdout);
  } catch {
    throw new Error(`${quoi} : sortie illisible (code ${resultat.code}) — ${resultat.stderr}`);
  }
}

function inode(chemin) {
  try { return fs.statSync(chemin).ino; } catch { return null; }
}

// La séquence exacte de la Phase A, rejouée sur un bureau jetable. `poser`
// crée le nouveau nom : `symlinkSync` pour la vraie bascule, `mkdirSync` pour
// le témoin négatif. Rien d'autre ne change entre les deux.
async function observerLaPhaseA(t, poser) {
  const home = fs.realpathSync(fs.mkdtempSync("/tmp/vpa-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ancien = path.join(home, ".cc2cc-v2");
  const neuf = path.join(home, ".valxos-messenger");
  fs.mkdirSync(ancien, { recursive: true });
  const obs = { home, ancien, neuf };

  // 1. L'écrivain tient la base par l'ANCIEN nom.
  const ecrivain = spawn(process.execPath, ["--input-type=module", "-e", SOURCE_ECRIVAIN], {
    env: envPropre({ HOME: home }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => ecrivain.kill());
  let stderrEcrivain = "";
  ecrivain.stderr.on("data", (b) => { stderrEcrivain += b; });
  const lignesEcrivain = readline.createInterface({ input: ecrivain.stdout })[Symbol.asyncIterator]();
  const demander = async (commande) => {
    if (commande) ecrivain.stdin.write(`${commande}\n`);
    const { value, done } = await lignesEcrivain.next();
    if (done) throw new Error(`écrivain mort : ${stderrEcrivain}`);
    return JSON.parse(value);
  };
  obs.ecrivainNe = await demander(null);
  obs.ecritAvantLeLien = await demander("ecrire");

  // 2. La Phase A, et rien d'autre.
  poser(ancien, neuf);

  // 3. L'écrivain continue d'écrire APRÈS le lien, sans avoir rien rouvert.
  obs.ecritApresLeLien = await demander("ecrire");

  // 4. Un processus neuf : où va-t-il, que voit-il, peut-il écrire ?
  const sonde = await lancer(SOURCE_SONDE, [neuf], home);
  obs.sonde = jsonDe(sonde, "sonde");
  obs.sondeStderr = sonde.stderr;

  // 5. L'écrivain de l'ancien nom relit : voit-il la lettre du nouveau ?
  obs.ecritApresLaSonde = await demander("ecrire");
  obs.ecrivainRelit = (await demander("lire")).lignes;

  // 6. Les trois fichiers de la base : un seul jeu d'inodes, ou deux ?
  obs.inodes = Object.fromEntries(
    ["broker.db", "broker.db-wal", "broker.db-shm"].map((f) => [
      f, { ancien: inode(path.join(ancien, f)), neuf: inode(path.join(neuf, f)) }
    ])
  );

  // 7. `list_peers` au niveau du CLI, par le nouveau nom : la fiche que
  // l'écrivain a posée par l'ancien doit y être.
  const pairs = await lancerNode([path.join(repo, "src/bin/valxos-peers.js"), "--all"], home);
  obs.pairs = jsonDe(pairs, "valxos-peers").peers.map((p) => p.id);
  obs.pairsStderr = pairs.stderr;

  // 8. Un socket posé par l'ancien nom, joint par le nouveau.
  const cheminSocket = path.join(ancien, "run", "ecrivain-ancien.sock");
  fs.mkdirSync(path.dirname(cheminSocket), { recursive: true });
  const serveur = net.createServer((c) => c.on("data", (b) => c.end(b)));
  t.after(() => serveur.close());
  await new Promise((ok) => serveur.listen(cheminSocket, ok));
  obs.socket = jsonDe(await lancer(SOURCE_SOCKET, [path.join(neuf, "run", "ecrivain-ancien.sock")], home), "socket");

  // 9. Le verrou du Facteur : pris par l'ancien nom (ce processus, vivant),
  // puis tenté par le nouveau depuis un AUTRE processus.
  const jeton = prendreLeVerrou(path.join(ancien, "run", "facteur.verrou"));
  obs.verrouPrisParLAncien = Boolean(jeton);
  if (jeton) t.after(() => jeton.relacher());
  obs.verrou = jsonDe(await lancer(SOURCE_VERROU, [neuf], home), "verrou");

  obs.stderrEcrivain = stderrEcrivain;
  return obs;
}

test("Phase A : une base, un socket, un verrou — par les deux noms, écrivain vivant", async (t) => {
  const obs = await observerLaPhaseA(t, (ancien, neuf) => fs.symlinkSync(ancien, neuf));
  const { ancien, neuf } = obs;

  // L'écrivain est bien un ancien processus : bureau historique, base WAL.
  assert.equal(obs.ecrivainNe.racine, ancien, "l'écrivain tient le bureau historique");
  assert.equal(obs.ecrivainNe.journal, "wal");
  assert.deepEqual([obs.ecritAvantLeLien.ecrit, obs.ecritApresLeLien.ecrit], [1, 2],
    "l'écrivain écrit avant ET après le lien sans rien rouvrir");

  // Le processus neuf choisit le nouveau nom, et le résolveur se tait.
  assert.equal(obs.sonde.base, neuf, "un processus neuf choisit le nouveau nom");
  assert.ok(!obs.sondeStderr.includes(AVERTISSEMENT), `aucun avertissement du résolveur : ${obs.sondeStderr}`);
  assert.equal(obs.sonde.erreur, undefined, `la sonde lit et écrit par le nouveau nom : ${obs.sonde.erreur}`);
  assert.equal(obs.sonde.journal, "wal");
  assert.deepEqual(obs.sonde.avant, [["ancien", 2]], "le nouveau nom voit les lignes d'avant ET d'après le lien");
  assert.equal(obs.sonde.ecrit, true);

  // L'écrivain de l'ancien nom voit la ligne écrite par le nouveau.
  assert.equal(obs.ecritApresLaSonde.ecrit, 3);
  assert.deepEqual(obs.ecrivainRelit, [["ancien", 3], ["neuf", 1]], "WAL partagé : chacun voit l'autre");

  for (const [f, { ancien: a, neuf: n }] of Object.entries(obs.inodes)) {
    assert.ok(a, `${f} existe sous l'ancien nom`);
    assert.equal(n, a, `${f} : même inode par les deux noms`);
  }

  assert.ok(obs.pairs.includes("ecrivain-ancien"), `list_peers par le nouveau nom voit la fiche : ${obs.pairs}`);
  assert.ok(!obs.pairsStderr.includes(AVERTISSEMENT), `valxos-peers se tait : ${obs.pairsStderr}`);

  assert.deepEqual(obs.socket, { recu: "A" }, "socket posé par l'ancien nom, joint par le nouveau");

  assert.ok(obs.verrouPrisParLAncien, "premier Facteur : verrou pris par l'ancien nom");
  assert.equal(obs.verrou.chemin, path.join(neuf, "run", "facteur.verrou"), "le produit cherche le verrou sous le nouveau nom");
  assert.equal(obs.verrou.pris, false, "un second Facteur par le nouveau nom ne prend pas le verrou d'un vivant");
});

test("témoin négatif : un dossier vide à la place du lien casse CHAQUE observation", async (t) => {
  const obs = await observerLaPhaseA(t, (_ancien, neuf) => fs.mkdirSync(neuf));
  const { ancien, neuf } = obs;

  // Le résolveur refuse le dossier nu et le DIT (Task 2).
  assert.equal(obs.sonde.base, ancien, "un dossier nu ne prouve rien : le résolveur reste sur l'historique");
  assert.match(obs.sondeStderr, /unproven office ignored/);

  // Par le chemin nu, la base est une autre base : rien à lire, rien d'écrit.
  assert.match(String(obs.sonde.erreur), /no such table: sonde/);
  assert.deepEqual(obs.ecrivainRelit, [["ancien", 3]], "aucune ligne du nouveau nom n'arrive à l'écrivain");

  assert.notEqual(obs.inodes["broker.db"].neuf, obs.inodes["broker.db"].ancien, "broker.db : deux fichiers");
  assert.equal(obs.inodes["broker.db-wal"].neuf, null, "pas de WAL partagé");
  assert.equal(obs.inodes["broker.db-shm"].neuf, null, "pas de mémoire partagée");

  assert.equal(obs.socket.erreur, "ENOENT", "le socket n'existe pas sous le nom nu");

  assert.ok(obs.verrouPrisParLAncien);
  assert.equal(obs.verrou.pris, true, "sans le lien, un second Facteur prend un second verrou");
});
