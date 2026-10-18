// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// F7 (passe adverse du Run 6, 28/09) — UN DRAPEAU INCONNU NE TOMBE JAMAIS DANS
// LE MODE PAR DÉFAUT.
//
// `facteur --une-tourne` (faute de frappe de --une-tournee) démarrait le
// DÉMON : il prenait `run/facteur.verrou` et portait du vrai courrier. Même
// classe que le `install.js --help` d'hier. Chaque bin qui passe par
// `parseArgs` déclare maintenant ses drapeaux : un drapeau inconnu rend
// l'usage et sort 2 AVANT d'ouvrir la base ou de prendre un verrou.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function lancer(t, bin, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-drapeau-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin", bin), ...args], {
    encoding: "utf8", timeout: 5000, env: envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: "testeur" })
  });
  return { r, root };
}

test("F7 — facteur --une-tourne (faute de frappe) sort 2 avec l'usage, sans base ni verrou", (t) => {
  const { r, root } = lancer(t, "facteur.js", ["--une-tourne"]);
  assert.equal(r.error, undefined, "le processus a rendu la main (pas de démon)");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag: --une-tourne/);
  assert.match(r.stderr, /--une-tournee/, "l'usage nomme le bon drapeau");
  assert.ok(!fs.existsSync(path.join(root, "run", "facteur.verrou")), "aucun verrou pris");
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucune base ouverte");
});

for (const [bin, args] of [
  ["valxos-send.js", ["--to", "quelqu-un", "--body", "x", "--bodyy", "y"]],
  ["valxos-inbox.js", ["--limt", "3"]],
  ["valxos-peers.js", ["--al"]],
  ["valxos-unregister.js", ["--idd", "x"]],
  ["valxos-chaise.js", ["lignees", "--jsn"]]
]) {
  test(`F7 — ${bin} ${args.join(" ")} : drapeau inconnu, sortie 2 avant toute base`, (t) => {
    const { r, root } = lancer(t, bin, args);
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /unknown flag: --/);
    assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucune base ouverte");
  });
}

test("F7 — les drapeaux connus passent toujours (facteur --une-tournee --silencieux)", (t) => {
  const { r } = lancer(t, "facteur.js", ["--une-tournee", "--silencieux", "--maisons", "/nulle-part"]);
  assert.equal(r.status, 0, r.stderr);
});

// N4 (seconde passe adverse du Run 6, 28/09) — LE TIRET SEUL ET LE MOT NU.
// `facteur -h` et `facteur une-tournee` démarraient le démon ; `valxos-send
// --to bob -h` postait une lettre dont le corps était « -h ». Désormais : `-h`
// affiche l'usage et sort 0 ; tout autre `-x` sort 2 ; un bin qui ne prend
// aucun argument positionnel refuse le mot nu (sortie 2).
test("N4 — facteur -h affiche l'usage, sort 0, sans verrou ni base", (t) => {
  const { r, root } = lancer(t, "facteur.js", ["-h"]);
  assert.equal(r.error, undefined, "rendu la main : pas de démon");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: facteur/);
  assert.ok(!fs.existsSync(path.join(root, "run", "facteur.verrou")));
  assert.ok(!fs.existsSync(path.join(root, "broker.db")));
});

test("N4 — facteur une-tournee (mot nu) sort 2, sans verrou", (t) => {
  const { r, root } = lancer(t, "facteur.js", ["une-tournee"]);
  assert.equal(r.error, undefined, "rendu la main : pas de démon");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument: une-tournee/);
  assert.ok(!fs.existsSync(path.join(root, "run", "facteur.verrou")));
});

test("N4 — valxos-send --to bob -h ne poste rien", (t) => {
  const { r, root } = lancer(t, "valxos-send.js", ["--to", "bob", "-h"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: valxos-send/);
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucune base ouverte, aucune lettre");
});

for (const [bin, args, code] of [
  ["valxos-send.js", ["--to", "bob", "-x"], 2],
  ["valxos-peers.js", ["-x"], 2],
  ["valxos-peers.js", ["mot"], 2],
  ["valxos-unregister.js", ["--id", "x", "mot"], 2],
  ["valxos-doctor.js", ["--bogus"], 2],
  ["valxos-doctor.js", ["mot"], 2],
  ["valxos-inbox.js", ["mot"], 2]
]) {
  test(`N4 — ${bin} ${args.join(" ")} : refusé (${code}) avant toute base`, (t) => {
    const { r, root } = lancer(t, bin, args);
    assert.equal(r.status, code, `${r.stdout}\n${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(root, "broker.db")), "aucune base ouverte");
  });
}

test("N4 — migrate-v1 refuse un argument inconnu et un mot nu (sortie 2)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-drapeau-v1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const args of [["--bogus"], ["mot"], ["-x"]]) {
    const r = spawnSync(process.execPath, [path.join(repo, "scripts/migrate-v1.js"), ...args], {
      encoding: "utf8", timeout: 5000, env: envPropre({ CC2CC_V2_HOME: root })
    });
    assert.equal(r.status, 2, `${args} : ${r.stdout}\n${r.stderr}`);
  }
  assert.ok(!fs.existsSync(path.join(root, "broker.db")));
});

// M1 (troisième passe adverse, 28/09) — UNE VALEUR N'EST JAMAIS UN DRAPEAU.
// `--body "- milk"` sortait 2 (« unknown flag »), et `--body "-h"` affichait
// l'usage et sortait 0 SANS ENVOYER : un script croyait la lettre partie.
// Après un drapeau à valeur, le jeton suivant est sa valeur, quoi qu'il
// ressemble ; seul un jeton en position de drapeau est lu comme un drapeau.
// `--` termine les options.
function lancerDans(root, bin, args, self = "testeur") {
  return spawnSync(process.execPath, [path.join(repo, "src/bin", bin), ...args], {
    encoding: "utf8", timeout: 5000, env: envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: self })
  });
}
for (const corps of ["- milk", "-h", "--- notes ---", "-1 degré"]) {
  test(`M1 — valxos-send --body ${JSON.stringify(corps)} envoie ce corps-là`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-valeur-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const r = lancerDans(root, "valxos-send.js", ["--to", "bob", "--body", corps, "--subject", "-1 day"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const sortie = JSON.parse(r.stdout);
    assert.equal(sortie.sent, true);
    const inbox = JSON.parse(lancerDans(root, "valxos-inbox.js", [], "bob").stdout);
    assert.equal(inbox.messages[0].body, corps);
    assert.equal(inbox.messages[0].subject, "-1 day");
  });
}

test("M1 — `--` termine les options : valxos-send --to bob -- \"- milk\"", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-valeur-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = lancerDans(root, "valxos-send.js", ["--to", "bob", "--", "- milk"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(lancerDans(root, "valxos-inbox.js", [], "bob").stdout).messages[0].body, "- milk");
});

test("M1 — un -h en position de drapeau affiche toujours l'usage ; `--flag=valeur` reste refusé avec son conseil", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-valeur-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = lancerDans(root, "valxos-send.js", ["--to", "bob", "-h"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage: valxos-send/);
  const egal = lancerDans(root, "valxos-send.js", ["--to=bob", "--body", "x"]);
  assert.equal(egal.status, 2);
  assert.match(egal.stderr, /use --to VALUE/);
  assert.ok(!fs.existsSync(path.join(root, "broker.db")), "rien posé");
});

test("M1 — sûreté : un drapeau déclaré n'est jamais pris pour une valeur (facteur --seulement-la-lettre --une-tournee ne démarre pas le démon)", (t) => {
  const { r, root } = lancer(t, "facteur.js", ["--seulement-la-lettre", "--une-tournee", "--silencieux"]);
  assert.equal(r.error, undefined, "rendu la main : jamais le démon");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /seulement-la-lettre-sans-identifiant/);
  assert.ok(!fs.existsSync(path.join(root, "run", "facteur.verrou")));
});

// F3 (revue finale, 18/10) — LES TROIS EXÉCUTABLES QUI N'AVAIENT NI AIDE NI REFUS.
//
// `valxos-web --help` ouvrait la porte dès qu'un opérateur était posé (et sortait
// 2, « refuses to start without an operator name », sinon) ; `valxos-migrate-home
// --help` sortait 1 (« unknown argument ») ; `valxos-monitor --help` construisait
// le moniteur, liait son socket et attendait. Les trois lisent maintenant leur
// ligne de commande AVANT d'ouvrir quoi que ce soit : `-h`/`--help` imprime
// l'usage et sort 0, un drapeau ou un mot inconnu sort 2, et le bureau reste tel
// qu'il était — ici, un dossier VIDE avant comme après.
function lancerScript(t, interprete, script, args, ajouts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-trois-sans-aide-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(interprete, [path.join(repo, script), ...args], {
    encoding: "utf8", timeout: 5000, env: envPropre({ CC2CC_V2_HOME: root, CC2CC_SELF: "testeur", ...ajouts })
  });
  return { r, root };
}

const TROIS_SANS_AIDE = [
  ["valxos-web", process.execPath, "src/bin/valxos-web.js", /valxos-web/],
  ["valxos-migrate-home", process.execPath, "scripts/migrate-home.js", /valxos-migrate-home/],
  ["valxos-monitor", "python3", "src/monitor/valxos_monitor.py", /valxos-monitor/]
];

for (const [nom, interprete, script, motif] of TROIS_SANS_AIDE) {
  for (const drapeau of ["--help", "-h"]) {
    test(`F3 — ${nom} ${drapeau} imprime l'usage, sort 0, et n'ouvre rien`, (t) => {
      const { r, root } = lancerScript(t, interprete, script, [drapeau]);
      assert.equal(r.error, undefined, `${nom} a rendu la main (ni porte ouverte, ni moniteur qui attend)`);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, motif, "l'usage nomme la commande");
      assert.deepEqual(fs.readdirSync(root), [], "aucun bureau, aucun web.env, aucune base : le dossier est resté vide");
    });
  }

  for (const [args, quoi] of [[["--bogus"], "--bogus"], [["-x"], "-x"], [["mot"], "mot"]]) {
    test(`F3 — ${nom} ${args.join(" ")} : refusé (2), le drapeau est nommé, rien n'est ouvert`, (t) => {
      const { r, root } = lancerScript(t, interprete, script, args);
      assert.equal(r.error, undefined, `${nom} a rendu la main`);
      assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
      assert.ok(r.stderr.includes(quoi), `le refus nomme « ${quoi} » : ${r.stderr}`);
      assert.deepEqual(fs.readdirSync(root), [], "rien n'est créé");
    });
  }
}

// Le cas qui coûtait le plus cher : un opérateur est posé, la porte aurait donc
// OUVERT — c'est le chemin où `--help` lançait un service sur le port. Port 0 :
// si la garde manque, le noyau en choisit un, et c'est le délai de 5 s du test
// (et non un port occupé) qui le fait rougir.
test("F3 — valxos-web --help avec un opérateur posé n'ouvre PAS la porte : pas de ligne PORTE, pas de web.env", (t) => {
  const { r, root } = lancerScript(t, process.execPath, "src/bin/valxos-web.js", ["--help"], {
    VALXOS_WEB_OPERATEUR: "alice", VALXOS_WEB_PORT: "0"
  });
  assert.equal(r.error, undefined, "rendu la main : la porte ne s'est pas ouverte");
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /PORTE/, "aucune adresse annoncée");
  assert.doesNotMatch(r.stderr, /web door open/, "aucune porte ouverte");
  assert.deepEqual(fs.readdirSync(root), [], "ni web.env, ni base, ni statut d'opérateur");
});

test("F3 — valxos-web --bogus avec un opérateur posé : refusé (2) avant d'ouvrir la porte", (t) => {
  const { r, root } = lancerScript(t, process.execPath, "src/bin/valxos-web.js", ["--bogus"], {
    VALXOS_WEB_OPERATEUR: "alice", VALXOS_WEB_PORT: "0"
  });
  assert.equal(r.error, undefined, "rendu la main : la porte ne s'est pas ouverte");
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /PORTE/);
  assert.deepEqual(fs.readdirSync(root), []);
});

// `--reap-only` garde son refus mot pour mot (test/registry.test.js le pin) : le
// parseur ne le remplace pas, il le connaît.
test("F3 — valxos-monitor --reap-only refuse toujours, exit 2, une seule ligne, rien d'ouvert", (t) => {
  const { r, root } = lancerScript(t, "python3", "src/monitor/valxos_monitor.py", ["--reap-only"]);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "valxos-monitor no longer harvests: run  valxos-chaise moissonner  (or valxos-doctor --reap)\n");
  assert.deepEqual(fs.readdirSync(root), []);
});

// A11 (revue qualité Q2, 18/10) — `valxos-messenger doctor` RELAIE SES ARGUMENTS.
// Le point d'entrée lançait le médecin avec une liste vide : `doctor --reap`
// rendait le rapport SANS moisson (« mode »: « rapport ») pendant que le README
// donne `valxos-doctor --reap` comme geste de moisson — un JSON qui a l'air bon
// et ne l'est pas — et `doctor --bogus` sortait 0.
function lancerMessenger(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-messenger-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return lancerScript(t, process.execPath, "src/bin/valxos-messenger.js", args, { HOME: home });
}

test("A11 — valxos-messenger doctor --reap relaie le drapeau : le médecin est en mode « moisson »", (t) => {
  const { r } = lancerMessenger(t, ["doctor", "--reap"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).checks.moisson.mode, "moisson");
});

test("A11 — valxos-messenger doctor sans drapeau reste un rapport", (t) => {
  const { r } = lancerMessenger(t, ["doctor"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).checks.moisson.mode, "rapport");
});

test("A11 — valxos-messenger doctor --bogus : refusé (2), le drapeau est nommé, rien n'est créé", (t) => {
  const { r, root } = lancerMessenger(t, ["doctor", "--bogus"]);
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("A11 — l'aide de valxos-messenger nomme [--reap] sous doctor", (t) => {
  const { r } = lancerMessenger(t, ["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /valxos-messenger doctor \[--reap\]/);
});

// Q11 (revue qualité) — un jeton qui est un DRAPEAU n'est pas une sous-commande
// inconnue : le message le dit. Un mot nu garde son message (test/sortie-unique.test.js).
test("Q11 — valxos-messenger --bogus : « Unknown flag », pas « Unknown subcommand »", (t) => {
  const { r } = lancerMessenger(t, ["--bogus"]);
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /^Unknown flag: --bogus\n/);
  assert.doesNotMatch(r.stderr, /Unknown subcommand/);
});

// Q11 — `valxos-chaise -h` imprimait la ligne d'usage du parseur, `--help` la
// liste des commandes : deux aides pour le même geste. C'est la même.
test("Q11 — valxos-chaise -h imprime la MÊME aide que --help (la liste des commandes), exit 0", (t) => {
  const court = lancer(t, "valxos-chaise.js", ["-h"]).r;
  const long = lancer(t, "valxos-chaise.js", ["--help"]).r;
  assert.equal(long.status, 0, long.stderr);
  assert.equal(court.status, 0, court.stderr);
  assert.match(long.stdout, /valxos-chaise lignees/, "SONDE : --help imprime bien la liste des commandes");
  assert.equal(court.stdout, long.stdout, "-h et --help disent la même chose, mot pour mot");
});
