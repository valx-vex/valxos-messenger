// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES DÉPENDANCES SE RÉSOLVENT — ELLES NE SE DEVINENT PAS À UN DOSSIER.
//
// Depuis un paquet npm installé (hoisté), `<paquet>/node_modules` n'existe
// pas : les dépendances vivent chez le parent. L'installeur qui testait ce
// dossier lançait `npm install` DANS node_modules/valxos-messenger — une
// seconde copie des dépendances, imbriquée, et un geste que personne n'a
// demandé. Ici le paquet est COPIÉ dans un faux `node_modules`, ses
// dépendances sont hoistées par lien symbolique quand le test le veut, et le
// seul `npm` que le PATH connaît est un script qui NOTE l'appel au lieu de
// l'exécuter.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { copieDuPaquet, fauxHome, lancer, rapport, repo } from "./aide-installeur.js";

const DEPENDANCES = Object.keys(JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).dependencies);

function fauxNpm(home) {
  const journal = path.join(home, "npm.journal");
  fs.writeFileSync(
    path.join(home, "bin", "npm"),
    "#!/bin/sh\n" +
      `printf '%s\\t' "$PWD" "$@" >> ${JSON.stringify(journal)}\n` +
      `printf '\\n' >> ${JSON.stringify(journal)}\n` +
      "exit 0\n",
    { mode: 0o755 }
  );
  return () =>
    fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").map((ligne) => ligne.split("\t").filter(Boolean))
      : [];
}

// Les dépendances « hoistées » : chez le parent du paquet, par lien vers celles
// du dépôt sous test — rien n'est téléchargé.
function hoister(nodeModulesDuParent) {
  for (const dep of DEPENDANCES) {
    const source = path.join(repo, "node_modules", dep);
    assert.ok(fs.existsSync(source), `SONDE IMPOSSIBLE : ${dep} absent du dépôt sous test`);
    const cible = path.join(nodeModulesDuParent, dep);
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.symlinkSync(source, cible);
  }
}

test("paquet hoisté, dépendances présentes chez le parent : aucun npm install", (t) => {
  const home = fauxHome(t);
  const appels = fauxNpm(home);
  const paquet = copieDuPaquet(path.join(home, "projet", "node_modules", "valxos-messenger"));
  hoister(path.join(home, "projet", "node_modules"));
  const sortie = lancer(home, ["--no-enable"], {}, { racine: paquet });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.deepEqual(appels(), [], "npm n'a pas été appelé");
  const json = rapport(sortie);
  assert.equal(json.npmInstall.ok, true);
  assert.match(json.npmInstall.stdout, /resolved/);
});

test("paquet hoisté, dépendances ABSENTES : refus net — jamais npm install sous node_modules", (t) => {
  const home = fauxHome(t);
  const appels = fauxNpm(home);
  const paquet = copieDuPaquet(path.join(home, "projet", "node_modules", "valxos-messenger"));
  const sortie = lancer(home, ["--no-enable"], {}, { racine: paquet });
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.deepEqual(appels(), [], "npm n'a pas été appelé");
  const json = rapport(sortie);
  assert.equal(json.npmInstall.ok, false);
  assert.match(json.npmInstall.stderr, /node_modules/);
  assert.match(json.npmInstall.stderr, /better-sqlite3/, "le refus nomme ce qui manque");
  assert.match(sortie.stdout, /missing/, "le résumé humain le dit aussi");
});

test("copie de dépôt, dépendances absentes : npm install tourne, DANS le dépôt — et un doctor qui ne peut pas tourner rend le verdict rouge", (t) => {
  const home = fauxHome(t);
  const appels = fauxNpm(home);
  const checkout = copieDuPaquet(path.join(home, "checkout"));
  const sortie = lancer(home, ["--no-enable"], {}, { racine: checkout });
  assert.deepEqual(appels(), [[checkout, "install"]], "un seul appel, depuis la racine du dépôt");
  // Le faux npm n'a rien installé : le doctor ne peut pas charger better-sqlite3.
  // Un installeur qui dirait « core install complete » ici mentirait.
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /doctor:\s+✗ could not run — .*better-sqlite3/);
  assert.equal(rapport(sortie).ok, false);
});

test("copie de dépôt, dépendances absentes, dry-run : annonce sans appeler", (t) => {
  const home = fauxHome(t);
  const appels = fauxNpm(home);
  const checkout = copieDuPaquet(path.join(home, "checkout"));
  const sortie = lancer(home, ["--dry-run"], {}, { racine: checkout });
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.deepEqual(appels(), []);
  assert.match(sortie.stdout, /\[would run\] npm install/);
});

// ── LE FILET DERRIÈRE LA DÉCISION NPM ───────────────────────────────────────
// Les dépendances se résolvent (le manifeste est là) mais l'une d'elles est
// CASSÉE — better-sqlite3 sans son build, « Could not locate the bindings
// file ». Le doctor plante à l'import. L'installeur disait alors « Overall:
// ✓ core install complete », exit 0, ligne doctor omise : un filet muet.
test("une dépendance au build cassé fait planter le doctor : le résumé le nomme et le verdict est rouge", (t) => {
  const home = fauxHome(t);
  const appels = fauxNpm(home);
  const parent = path.join(home, "projet", "node_modules");
  const paquet = copieDuPaquet(path.join(parent, "valxos-messenger"));
  hoister(parent);
  // better-sqlite3 : un faux paquet, résolu par son manifeste, qui jette à l'import
  // exactement ce qu'un build absent jette.
  const casse = path.join(parent, "better-sqlite3");
  fs.rmSync(casse, { force: true });
  fs.mkdirSync(path.join(casse, "lib"), { recursive: true });
  fs.writeFileSync(path.join(casse, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "lib/index.js" }));
  fs.writeFileSync(
    path.join(casse, "lib", "index.js"),
    "throw new Error('Could not locate the bindings file. Tried:\\n \u2192 ' + __dirname + '/build/Release/better_sqlite3.node');\n"
  );

  const sortie = lancer(home, ["--no-enable"], {}, { racine: paquet });
  assert.deepEqual(appels(), [], "les dépendances se résolvent : pas de npm install");
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /doctor:\s+✗ could not run — .*Could not locate the bindings file/, "la première ligne d'erreur du doctor est dans le résumé");
  assert.doesNotMatch(sortie.stdout, /Overall: ✓/, "aucun « complete » au-dessus d'un doctor qui n'a pas pu tourner");
  const json = rapport(sortie);
  assert.equal(json.ok, false);
  assert.equal(json.doctorVerdict, null);
  assert.match(json.doctorError, /bindings/);
});

// N3 (seconde passe adverse du Run 6, 28/09) — LE BINDING NATIF SE PROUVE.
// Sous npm 12, `npm i -g` bloque le script d'installation de better-sqlite3 :
// le manifeste est là, le binding non. L'installeur disait « dependencies
// resolved » et, en dry-run, « core install complete ». Il charge désormais
// better-sqlite3 et ouvre `:memory:` ; en échec, le dry-run ET l'installation
// sont rouges, avec la commande exacte. Le banc : un paquet `better-sqlite3`
// de remplacement dans l'arbre copié, qui jette à l'import ce qu'un build
// absent jette (aucun interrupteur réservé aux tests dans le produit).
function bindingCasse(parent) {
  const casse = path.join(parent, "better-sqlite3");
  fs.rmSync(casse, { recursive: true, force: true });
  fs.mkdirSync(path.join(casse, "lib"), { recursive: true });
  fs.writeFileSync(path.join(casse, "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "lib/index.js" }));
  fs.writeFileSync(path.join(casse, "lib", "index.js"), "throw new Error('Could not locate the bindings file.');\n");
  return casse;
}

for (const mode of [["--dry-run"], ["--no-enable"]]) {
  test(`N3 — binding natif absent : ${mode[0]} est ROUGE avec la commande exacte, jamais « core install complete »`, (t) => {
    const home = fauxHome(t);
    const appels = fauxNpm(home);
    const parent = path.join(home, "prefix", "lib", "node_modules", "valxos-messenger", "node_modules");
    const paquet = copieDuPaquet(path.dirname(parent));
    hoister(parent);
    bindingCasse(parent);
    const sortie = lancer(home, mode, {}, { racine: paquet });
    assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
    assert.deepEqual(appels(), [], "aucun npm install : le manifeste est là");
    // La commande EXACTE, vérifiée sur npm 12.1.0 : le `npm rebuild
    // better-sqlite3 --allow-scripts=…` DANS le paquet est refusé par npm 12
    // (EALLOWSCRIPTS : « not allowed in project-scoped installs ») ; la forme
    // globale, elle, reconstruit.
    const prefix = path.resolve(paquet, "..", "..", "..");
    const attendu = `native binding missing: run \`npm rebuild -g better-sqlite3 --allow-scripts=better-sqlite3 --prefix ${prefix}\``;
    assert.ok(sortie.stdout.includes(attendu), `ligne exacte attendue :\n${attendu}\n---\n${sortie.stdout}`);
    assert.doesNotMatch(sortie.stdout, /Overall: ✓/);
    assert.equal(rapport(sortie).npmInstall.ok, false);
    assert.equal(rapport(sortie).npmInstall.stderr, attendu);
  });
}

test("N3 — binding natif absent dans un clone (pas un préfixe global) : la route allowScripts + npm rebuild, rouge", (t) => {
  const home = fauxHome(t);
  fauxNpm(home);
  const checkout = copieDuPaquet(path.join(home, "checkout"));
  hoister(path.join(checkout, "node_modules"));
  bindingCasse(path.join(checkout, "node_modules"));
  const sortie = lancer(home, ["--dry-run"], {}, { racine: checkout });
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  const attendu = `native binding missing: in ${checkout}, allow better-sqlite3's install script ("allowScripts" in package.json, or .npmrc) and run \`npm rebuild better-sqlite3\``;
  assert.equal(rapport(sortie).npmInstall.stderr, attendu);
});
