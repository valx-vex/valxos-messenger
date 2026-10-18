// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// The mint of the door token is ATOMIC, SERIALIZED, and hands out what is
// PERSISTED. Born red on 2026-08-29 from the adverse review's re-verdict on
// rc2 (F2, residual): the merge was right (the operator survives, 0600) but
// the write was a bare `writeFileSync` — a crash mid-write truncated web.env,
// the very file the merge had just learned not to erase, and two concurrent
// mints on a fresh file handed out two tokens, one of which the file never
// knew (24/40 in the adverse review). A caller must never receive a token the
// file does not know.
//
// Every test works on a throwaway web.env passed explicitly: nothing here
// resolves the operator's home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { CLEF_DU_JETON, chargerLeJeton } from "../src/web/auth.js";

const MODULE_URL = new URL("../src/web/auth.js", import.meta.url).href;

function bureau() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-web-jeton-atomique-"));
  return { dir, fichier: path.join(dir, "web.env") };
}

function jetonDuFichier(fichier) {
  const ligne = fs.readFileSync(fichier, "utf8").split("\n").find((l) => l.startsWith(`${CLEF_DU_JETON}=`));
  return ligne ? ligne.slice(CLEF_DU_JETON.length + 1).trim() : "";
}

// A child that mints on the same file, in another process — the only way to
// mint concurrently, since the mint is synchronous. The children wait at a
// BARRIER: each one announces itself in `pret/`, then spins until `go` exists.
// Without it, node's staggered start-up spreads the 40 mints over tens of
// milliseconds and the race is missed more often than not — a test that does
// not bite proves nothing.
function enfantQuiMinte(fichier, { pret, go }) {
  const source =
    'const fs = await import("node:fs");' +
    `const m = await import(${JSON.stringify(MODULE_URL)});` +
    `fs.writeFileSync(${JSON.stringify(pret)} + "/" + process.pid, "");` +
    `while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);` +
    `process.stdout.write(m.chargerLeJeton({ fichier: ${JSON.stringify(fichier)}, env: {} }));`;
  return new Promise((resolve, reject) => {
    const enfant = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", TMPDIR: process.env.TMPDIR || "" }
    });
    let sortie = "";
    let plainte = "";
    enfant.stdout.on("data", (d) => { sortie += d; });
    enfant.stderr.on("data", (d) => { plainte += d; });
    enfant.on("error", reject);
    enfant.on("close", (code) => (code === 0 ? resolve(sortie.trim()) : reject(new Error(`mint exited ${code}: ${plainte}`))));
  });
}

function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("after a mint, only web.env remains in its directory — no temporary file, no lock left behind", () => {
  const { dir, fichier } = bureau();
  chargerLeJeton({ fichier, env: {} });
  assert.deepEqual(fs.readdirSync(dir), ["web.env"]);
});

// 40 children at the barrier, one shot: the tokens they were handed, in order.
async function quaranteMintsALaBarriere(fichier) {
  const camp = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-mint-barriere-"));
  const barriere = { pret: path.join(camp, "pret"), go: path.join(camp, "go") };
  fs.mkdirSync(barriere.pret);
  const enfants = Promise.all(Array.from({ length: 40 }, () => enfantQuiMinte(fichier, barriere)));
  // Everyone at the barrier, then the shot.
  for (let i = 0; i < 3000 && fs.readdirSync(barriere.pret).length < 40; i += 1) dormir(10);
  assert.equal(fs.readdirSync(barriere.pret).length, 40, "all 40 children must be at the barrier before the mint");
  fs.writeFileSync(barriere.go, "");
  const jetons = await enfants;
  fs.rmSync(camp, { recursive: true, force: true });
  return jetons;
}

function webEnvDeDepart(fichier) {
  fs.writeFileSync(fichier, [
    "# door settings",
    "VALXOS_WEB_OPERATEUR=operator",
    "VALXOS_WEB_CADRE_AUTORISE=http://command-center.example",
    ""
  ].join("\n"), { mode: 0o600 });
}

test("40 concurrent mints on a fresh web.env hand out ONE token — the one the file knows", { timeout: 60_000 }, async () => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);

  const jetons = await quaranteMintsALaBarriere(fichier);

  const persiste = jetonDuFichier(fichier);
  assert.match(persiste, /^[0-9a-f]{64}$/, "the file carries one well-formed token");
  const differents = new Set(jetons);
  assert.equal(differents.size, 1, `${differents.size} different tokens were handed out for a single file`);
  assert.equal(jetons[0], persiste, "the token handed out is the token the file knows");

  const lignes = fs.readFileSync(fichier, "utf8").split("\n").filter(Boolean);
  assert.equal(lignes.filter((l) => l.startsWith(`${CLEF_DU_JETON}=`)).length, 1, "exactly one token line");
  assert.ok(lignes.includes("VALXOS_WEB_OPERATEUR=operator"), "the operator survives");
  assert.ok(lignes.includes("VALXOS_WEB_CADRE_AUTORISE=http://command-center.example"), "the frame list survives");
  assert.ok(lignes.includes("# door settings"), "comments survive");
  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "no temporary file, no lock left behind");
});

test("a stale lock (its holder is dead) is cleaned up, not waited on forever", () => {
  const { dir, fichier } = bureau();
  // 2147483647 is above any pid the kernel hands out: nobody holds this lock.
  fs.writeFileSync(path.join(dir, "web.env.lock"), "2147483647\n", { mode: 0o600 });
  const debut = Date.now();
  const jeton = chargerLeJeton({ fichier, env: {} });
  assert.ok(Date.now() - debut < 2000, "a dead lock is swept, not waited on");
  assert.equal(jetonDuFichier(fichier), jeton);
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "the stale lock is gone");
});

// THE THEFT OF A STALE LOCK IS ITSELF A RACE (rev-t7, 2026-08-29, HIGH). Two
// waiters judge the same lock stale; the first renames it away and takes a
// fresh lock; the second, already past its verdict, renames THAT fresh lock
// away and takes its own: both mint at once — up to 24/40 callers with a
// token the file never knew, the adverse review's exact figure. The theft
// must be serialized, and the verdict re-checked under that serialization.
function quaranteMintsSurVerrouPerime(poserLeVerrou) {
  return async () => {
    const { dir, fichier } = bureau();
    webEnvDeDepart(fichier);
    poserLeVerrou(path.join(dir, "web.env.lock"));

    const jetons = await quaranteMintsALaBarriere(fichier);

    const persiste = jetonDuFichier(fichier);
    assert.match(persiste, /^[0-9a-f]{64}$/);
    const inconnus = jetons.filter((j) => j !== persiste).length;
    assert.equal(inconnus, 0, `${inconnus}/40 callers were handed a token the file does not know (${new Set(jetons).size} different tokens)`);
    const lignes = fs.readFileSync(fichier, "utf8").split("\n").filter(Boolean);
    assert.equal(lignes.filter((l) => l.startsWith(`${CLEF_DU_JETON}=`)).length, 1, "exactly one token line");
    assert.ok(lignes.includes("VALXOS_WEB_OPERATEUR=operator"), "the operator survives");
    assert.deepEqual(fs.readdirSync(dir), ["web.env"], "no lock, no theft lock, no temporary file left behind");
  };
}

test("40 mints at the barrier over a stale lock (dead pid) hand out ONE token — the theft is serialized", { timeout: 60_000 },
  quaranteMintsSurVerrouPerime((verrou) => {
    fs.writeFileSync(verrou, "2147483647\n", { mode: 0o600 });
  }));

test("40 mints at the barrier over a stale lock (live pid, 60 s old) hand out ONE token", { timeout: 60_000 },
  quaranteMintsSurVerrouPerime((verrou) => {
    fs.writeFileSync(verrou, `${process.pid}\n`, { mode: 0o600 });
    const passe = new Date(Date.now() - 60_000);
    fs.utimesSync(verrou, passe, passe);
  }));

// The deterministic face of the same property: the theft is serialized under
// `web.env.lock.vol`. While another thief holds it, a stale main lock is NOT
// stolen — the mint waits on it, and here (nobody ever releases) gives up by
// name. The old code had no notion of a theft lock and stole at once.
test("while another thief holds the theft lock, a stale lock is not stolen: the mint waits, then gives up by name", { timeout: 20_000 }, () => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  fs.writeFileSync(path.join(dir, "web.env.lock"), "2147483647\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "web.env.lock.vol"), `${process.pid}\n`, { mode: 0o600 });
  assert.throws(() => chargerLeJeton({ fichier, env: {}, attenteMaxMs: 300 }), /verrou|lock/i);
  assert.equal(jetonDuFichier(fichier), "", "nothing was minted behind a theft that was never ours");
  assert.ok(fs.existsSync(path.join(dir, "web.env.lock")), "the stale lock was not stolen while the theft lock was held");
  assert.ok(fs.existsSync(path.join(dir, "web.env.lock.vol")), "and the other thief's lock is untouched");
});

// THE RE-CHECK UNDER THE THEFT LOCK IS LOAD-BEARING, AND IT IS PINNED HERE
// (rev-t7, M1): sweeping the main lock unconditionally once the theft lock is
// held kept the whole file green while the 40-child toy still handed out two
// tokens now and then. Deterministic face: the FIRST pid write is the theft
// lock's (the main lock's wx just failed with EEXIST); at that instant the
// stale main lock is replaced by a LIVE one. The re-check must see it, steal
// nothing, and the mint must give up by name — writing nothing, leaving the
// live lock intact.
test("M1: a lock that turns live between the verdict and the theft is not stolen — the re-check under the theft lock decides", (t) => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  const verrou = path.join(dir, "web.env.lock");
  const reel = fs.realpathSync(fichier);
  fs.writeFileSync(verrou, "2147483647\n", { mode: 0o600 }); // stale: nobody holds this pid
  const vraiWrite = fs.writeSync;
  let premierPid = true;
  t.mock.method(fs, "writeSync", (fd, data, ...reste) => {
    const r = vraiWrite(fd, data, ...reste);
    if (premierPid && String(data) === `${process.pid}\n`) {
      premierPid = false; // the theft lock's pid — the main lock was judged stale a moment ago
      fs.unlinkSync(`${reel}.lock`);
      fs.writeFileSync(`${reel}.lock`, `${process.pid}\n`, { mode: 0o600 }); // and is now LIVE
    }
    return r;
  });
  assert.throws(() => chargerLeJeton({ fichier, env: {}, attenteMaxMs: 300 }), /verrou|lock/i);
  assert.equal(premierPid, false, "SONDE IMPOSSIBLE : the theft lock was never taken, the scenario did not happen");
  assert.equal(jetonDuFichier(fichier), "", "nothing was minted behind a lock that was not ours");
  assert.equal(fs.readFileSync(verrou, "utf8"), `${process.pid}\n`, "the live lock is intact");
  assert.ok(!fs.existsSync(`${verrou}.vol`), "the theft lock was released");
});

test("a theft lock whose holder is dead is swept along with the stale lock, and the mint proceeds", () => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  fs.writeFileSync(path.join(dir, "web.env.lock"), "2147483647\n", { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "web.env.lock.vol"), "2147483647\n", { mode: 0o600 });
  const jeton = chargerLeJeton({ fichier, env: {}, attenteMaxMs: 2000 });
  assert.equal(jetonDuFichier(fichier), jeton);
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "both stale locks are gone");
});

// Another process holds the lock, then persists ITS token: the mint that
// waited must hand out that token, never a fresh one the file does not know.
test("a live lock is waited on, and the mint then returns the token the holder persisted", { timeout: 20_000 }, async () => {
  const { dir, fichier } = bureau();
  const verrou = path.join(dir, "web.env.lock");
  const jetonDuTenant = "ab".repeat(32);
  const source = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(verrou)}, String(process.pid) + "\\n");`,
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
    `fs.writeFileSync(${JSON.stringify(fichier)}, "VALXOS_WEB_OPERATEUR=operator\\n${CLEF_DU_JETON}=${jetonDuTenant}\\n");`,
    `fs.unlinkSync(${JSON.stringify(verrou)});`
  ].join("\n");
  const tenant = spawn(process.execPath, ["-e", source], { stdio: "ignore" });
  const fini = new Promise((resolve) => tenant.on("close", resolve));
  // Wait until the holder has taken the lock before minting.
  for (let i = 0; i < 500 && !fs.existsSync(verrou); i += 1) dormir(10);
  assert.ok(fs.existsSync(verrou), "the holder must have taken the lock before the mint starts");

  const jeton = chargerLeJeton({ fichier, env: {} });
  await fini;
  assert.equal(jeton, jetonDuTenant, "the mint waited, then handed out the holder's token — not a fresh one");
  assert.equal(jetonDuFichier(fichier), jetonDuTenant, "and the file knows that token");
  assert.deepEqual(fs.readdirSync(dir), ["web.env"]);
});

// ── THE TWO PROPERTIES THAT NO TEST PINNED (rev-t7, MEDIUM 2) ────────────────
// ② the mint returns what the file holds after the rename, not the token it
//    meant to write; ③ the write is temp + fsync + rename, so a failure in
//    the middle leaves the original byte for byte and no temporary file.
// Both are pinned through `node:test`'s mock on the `fs` default export —
// the very object auth.js calls — never through a hook in production code.

test("② the mint hands out what the file holds after the rename — a write that lands right after it wins", (t) => {
  const { fichier } = bureau();
  webEnvDeDepart(fichier);
  const jetonDUnTiers = "cd".repeat(32);
  const vraiRename = fs.renameSync;
  const reel = fs.realpathSync(fichier); // the mint renames onto the REAL file (B7)
  // The rename happens for real; a third party's write lands on the file
  // before the mint re-reads it.
  t.mock.method(fs, "renameSync", (source, cible) => {
    vraiRename(source, cible);
    if (cible === reel) fs.writeFileSync(cible, `VALXOS_WEB_OPERATEUR=operator\n${CLEF_DU_JETON}=${jetonDUnTiers}\n`);
  });
  const rendu = chargerLeJeton({ fichier, env: {} });
  assert.equal(jetonDuFichier(fichier), jetonDUnTiers, "the third party's write did land (otherwise this test proves nothing)");
  assert.equal(rendu, jetonDUnTiers, "the mint returned the token the file knows, not the one it meant to write");
});

test("③ a rename that fails leaves the original web.env intact byte for byte, and no temporary file", (t) => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  const avant = fs.readFileSync(fichier);
  t.mock.method(fs, "renameSync", () => {
    const e = new Error("EIO: simulated"); e.code = "EIO"; throw e;
  });
  assert.throws(() => chargerLeJeton({ fichier, env: {} }), /EIO/);
  assert.deepEqual(fs.readFileSync(fichier), avant, "the original is intact, byte for byte");
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "no temporary file, no lock left behind");
});

test("③ a write that dies in the middle of the content leaves the original intact and no temporary file", (t) => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  const avant = fs.readFileSync(fichier);
  const vraiWrite = fs.writeSync;
  // The lock's pid write goes through; the content write (it carries the
  // token key) dies half-way.
  t.mock.method(fs, "writeSync", (fd, data, ...reste) => {
    if (String(data).includes(`${CLEF_DU_JETON}=`)) {
      vraiWrite(fd, String(data).slice(0, 10));
      const e = new Error("ENOSPC: simulated"); e.code = "ENOSPC"; throw e;
    }
    return vraiWrite(fd, data, ...reste);
  });
  assert.throws(() => chargerLeJeton({ fichier, env: {} }), /ENOSPC/);
  assert.deepEqual(fs.readFileSync(fichier), avant, "the original is intact, byte for byte");
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "no temporary file, no lock left behind");
});

// ── THE SMALL ONES (rev-t7, LOW) ─────────────────────────────────────────────

// B7: `web.env` may be a symbolic link (an operator keeping the door's
// settings elsewhere). The temporary file must be born next to the REAL
// file and renamed over the REAL file — a rename over the link replaced the
// link itself with a regular file, and the settings the operator kept
// elsewhere fell out of the door's sight on the next launch.
test("B7: minting through a symlinked web.env writes the real file and keeps the link", () => {
  const { dir: vrai } = bureau();
  const { dir: ailleurs } = bureau();
  const fichierReel = path.join(vrai, "web.env");
  webEnvDeDepart(fichierReel);
  const lien = path.join(ailleurs, "web.env");
  fs.symlinkSync(fichierReel, lien);

  const jeton = chargerLeJeton({ fichier: lien, env: {} });

  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "the link is still a link");
  assert.equal(jetonDuFichier(fichierReel), jeton, "the token was written into the real file");
  assert.match(fs.readFileSync(fichierReel, "utf8"), /^VALXOS_WEB_OPERATEUR=operator$/m, "the operator survives");
  assert.equal(fs.statSync(fichierReel).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(vrai), ["web.env"], "no temporary file, no lock next to the real file");
  assert.deepEqual(fs.readdirSync(ailleurs), ["web.env"], "nothing next to the link either");
});

test("B7: a dangling symlink to a web.env that does not exist yet is followed — the file is born at the link's target", () => {
  const { dir: vrai } = bureau();
  const { dir: ailleurs } = bureau();
  const fichierReel = path.join(vrai, "web.env");
  const lien = path.join(ailleurs, "web.env");
  fs.symlinkSync(fichierReel, lien);

  const jeton = chargerLeJeton({ fichier: lien, env: {} });

  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "the link is still a link");
  assert.equal(jetonDuFichier(fichierReel), jeton, "the file was born at the link's target");
  assert.deepEqual(fs.readdirSync(vrai), ["web.env"]);
});

// B8: an exception between the wx create and the pid write must not leave an
// empty, orphaned lock — it would hold everyone until it ages out.
test("B8: a failure right after the lock is created removes the lock just created", (t) => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  const vraiWrite = fs.writeSync;
  t.mock.method(fs, "writeSync", (fd, data, ...reste) => {
    if (String(data) === `${process.pid}\n`) {
      const e = new Error("EIO: simulated on the pid write"); e.code = "EIO"; throw e;
    }
    return vraiWrite(fd, data, ...reste);
  });
  assert.throws(() => chargerLeJeton({ fichier, env: {} }), /EIO/);
  assert.deepEqual(fs.readdirSync(dir), ["web.env"], "no orphaned lock, no temporary file");
});

// B9: the release is conditional on the inode created. If our lock was judged
// stale and stolen while we minted, what carries its name now belongs to a
// legitimate thief — erasing it would restart the cascade.
test("B9: the mint never erases a lock that is no longer its own", (t) => {
  const { dir, fichier } = bureau();
  webEnvDeDepart(fichier);
  const verrou = path.join(dir, "web.env.lock");
  const vraiRename = fs.renameSync;
  const reel = fs.realpathSync(fichier); // the mint renames onto the REAL file (B7)
  // While we mint (right at the rename), a thief replaces our lock with its own.
  t.mock.method(fs, "renameSync", (source, cible) => {
    vraiRename(source, cible);
    if (cible === reel) {
      fs.unlinkSync(verrou);
      fs.writeFileSync(verrou, "2147483647\n", { mode: 0o600 });
    }
  });
  chargerLeJeton({ fichier, env: {} });
  assert.ok(fs.existsSync(verrou), "the thief's lock survives our release");
  assert.equal(fs.readFileSync(verrou, "utf8"), "2147483647\n", "and it is still the thief's");
});

test("a lock held for too long is not waited on forever: the mint gives up with a named error", { timeout: 20_000 }, () => {
  const { dir, fichier } = bureau();
  // A live holder (this very process) that never releases.
  fs.writeFileSync(path.join(dir, "web.env.lock"), `${process.pid}\n`, { mode: 0o600 });
  const debut = Date.now();
  assert.throws(() => chargerLeJeton({ fichier, env: {}, attenteMaxMs: 300 }), /verrou|lock/i);
  const ecoule = Date.now() - debut;
  assert.ok(ecoule >= 250 && ecoule < 5000, `the wait is bounded by what the caller asked (${ecoule} ms)`);
  assert.ok(!fs.existsSync(fichier), "nothing was written behind a lock that was never obtained");
});
