// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// CE QU'UN TEST POSE GOUVERNE — ce que le lanceur avait exporté ne descend pas.
//
// Deux portes pour une même règle : l'environnement d'un ENFANT (envPropre) et
// le bureau EN-PROCESSUS (poserLeBureau). Les deux sont éprouvées contre un
// lanceur qui exporte tout ce qu'il ne devrait pas transmettre.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { baseDir } from "../src/lib/config.js";
import { CLEFS_DU_LANCEUR, envPropre, poserLeBureau } from "./aide-env.js";

function enSimulantLeLanceur(t, exportees) {
  const avant = Object.fromEntries(CLEFS_DU_LANCEUR.map((clef) => [clef, process.env[clef]]));
  for (const clef of CLEFS_DU_LANCEUR) delete process.env[clef];
  Object.assign(process.env, exportees);
  t.after(() => {
    for (const clef of CLEFS_DU_LANCEUR) {
      if (avant[clef] === undefined) delete process.env[clef];
      else process.env[clef] = avant[clef];
    }
  });
}

test("envPropre() retire les clefs du lanceur et garde ce que le test pose", (t) => {
  enSimulantLeLanceur(t, {
    VALXOS_MESSENGER_HOME: "/nulle/part/bureau",
    CC2CC_V2_HOME: "/nulle/part/ancien",
    CLAUDE_CONFIG_DIR: "/nulle/part/maison",
    CC2CC_GARDE_BUREAU: "1"
  });
  const env = envPropre({ CC2CC_V2_HOME: "/le/mien", CC2CC_SELF: "moi" });
  for (const clef of ["VALXOS_MESSENGER_HOME", "CLAUDE_CONFIG_DIR", "CC2CC_GARDE_BUREAU", "VALXOS_GARDE_BUREAU"]) {
    assert.equal(clef in env, false, `${clef} est descendue du lanceur`);
  }
  assert.equal(env.CC2CC_V2_HOME, "/le/mien");
  assert.equal(env.CC2CC_SELF, "moi");
  assert.equal(env.PATH, process.env.PATH, "le reste de l'environnement passe tel quel");
});

test("poserLeBureau() fait gagner le bureau du test contre le VALXOS_MESSENGER_HOME du lanceur", (t) => {
  const bureauDuLanceur = fs.mkdtempSync(path.join(os.tmpdir(), "bureau-du-lanceur-"));
  const mien = fs.mkdtempSync(path.join(os.tmpdir(), "bureau-du-test-"));
  t.after(() => {
    fs.rmSync(bureauDuLanceur, { recursive: true, force: true });
    fs.rmSync(mien, { recursive: true, force: true });
  });
  enSimulantLeLanceur(t, { VALXOS_MESSENGER_HOME: bureauDuLanceur });
  assert.equal(baseDir(), bureauDuLanceur, "SONDE IMPOSSIBLE : le lanceur simulé n'impose pas son bureau");

  poserLeBureau(mien);
  assert.equal(baseDir(), mien, "le bureau posé par le test doit gouverner");
  assert.equal(process.env.CC2CC_V2_HOME, mien);
  assert.equal("VALXOS_MESSENGER_HOME" in process.env, false, "la clef neuve du lanceur ne survit pas");
});

// L'IDENTITÉ DU LANCEUR NE DESCEND PAS NON PLUS (Run 6, tâche 1, 27/09).
// Mesuré : un lanceur qui exporte `VALXOS_SELF` (une session enregistrée au
// Messenger) faisait perdre à CHAQUE enfant le `CC2CC_SELF` que son test
// posait — la famille VALXOS_* gagne (config.js). 28 tests rouges et deux
// fichiers pendus jusqu'au plafond de 900 s (le moniteur attendait un socket
// nommé d'après le lanceur, jamais d'après le test). Même règle que le bureau.
test("envPropre() retire aussi l'identité du lanceur — SELF et SESSION_NAME, les deux familles", (t) => {
  const clefs = ["VALXOS_SELF", "CC2CC_SELF", "VALXOS_SESSION_NAME", "CC2CC_SESSION_NAME"];
  const avant = Object.fromEntries(clefs.map((clef) => [clef, process.env[clef]]));
  t.after(() => {
    for (const clef of clefs) {
      if (avant[clef] === undefined) delete process.env[clef];
      else process.env[clef] = avant[clef];
    }
  });
  for (const clef of clefs) process.env[clef] = "lanceur-qui-fuit";
  const nu = envPropre();
  for (const clef of clefs) assert.equal(clef in nu, false, `${clef} est descendue du lanceur`);
  const pose = envPropre({ CC2CC_SELF: "moi" });
  assert.equal(pose.CC2CC_SELF, "moi", "ce que le test pose gouverne");
  assert.equal("VALXOS_SELF" in pose, false, "la clef neuve du lanceur ne bat plus la clef que le test pose");
});

// AUCUN ENFANT DE TEST N'ÉCRIT DE BYTECODE DANS L'ARBRE (C1, FIX-C, 18/10).
// Le moniteur est un script Python : tout test qui l'importe par `importlib`
// écrit `src/monitor/__pycache__/*.pyc` (chemin absolu de la source, octets NUL),
// et `prepublishOnly` lance la suite juste avant le `pack`. Les tests portent
// `-B`, mais une règle qui repose sur chaque auteur de test se perd au premier
// oubli : `envPropre()` pose `PYTHONDONTWRITEBYTECODE` pour tous les enfants,
// et ce qu'un test pose explicitement gouverne toujours.

function sansPrefixeDeCache(env) {
  const propre = { ...env };
  delete propre.PYTHONPYCACHEPREFIX;
  return propre;
}

// Preuve par l'effet, sur une COPIE du moniteur (jamais l'arbre) : un import sans `-B` ne laisse
// rien avec envPropre(), et laisse un __pycache__ quand la variable est vidée (le témoin — sans
// lui, un python3 qui n'écrirait jamais de bytecode ferait passer la preuve pour rien).
function sondeDuBytecode(t) {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  assert.equal(python.status, 0, `SONDE IMPOSSIBLE : python3 ne tourne pas sur ce PATH (${python.error?.message ?? python.stderr}) — les tests du moniteur en ont besoin aussi`);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-bytecode-env-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const moniteur = path.join(dossier, "moniteur.py");
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "monitor", "valxos_monitor.py"), moniteur);
  // Sans PYTHONPYCACHEPREFIX, pour les DEUX enfants (voir le test suivant) : avec lui, le cache ne
  // tombe jamais à côté de la source, et la première assertion passerait même sans l'interdiction.
  const importer = (env) => spawnSync("python3", ["-c",
    "import importlib.util,sys; " +
    `s=importlib.util.spec_from_file_location('moniteur',${JSON.stringify(moniteur)}); ` +
    "m=importlib.util.module_from_spec(s);sys.modules[s.name]=m;s.loader.exec_module(m)"], { encoding: "utf8", env: sansPrefixeDeCache(env), cwd: dossier });
  const cache = path.join(dossier, "__pycache__");

  const avec = importer(envPropre({ HOME: dossier }));
  assert.equal(avec.status, 0, avec.stderr);
  assert.equal(fs.existsSync(cache), false, "envPropre() : l'import n'a laissé aucun __pycache__");

  const temoin = importer(envPropre({ HOME: dossier, PYTHONDONTWRITEBYTECODE: "" }));
  assert.equal(temoin.status, 0, temoin.stderr);
  assert.equal(fs.existsSync(cache), true, "sonde impossible : sans l'interdiction, l'import aurait dû laisser un __pycache__");
}

test("envPropre() interdit le bytecode Python à tout enfant, et l'interdiction tient pour un vrai import", (t) => {
  assert.equal(envPropre().PYTHONDONTWRITEBYTECODE, "1", "l'enfant par défaut n'écrit pas de bytecode");
  assert.equal(envPropre({ PYTHONDONTWRITEBYTECODE: "" }).PYTHONDONTWRITEBYTECODE, "", "ce que le test pose gouverne");
  sondeDuBytecode(t);
});

// LA SONDE NE DÉPEND PAS DE L'ENVIRONNEMENT DU DÉVELOPPEUR (FIX-D, D2, 18/10). Un développeur qui exporte
// `PYTHONPYCACHEPREFIX` voit Python écrire son cache sous ce préfixe, jamais à côté de la source : le
// témoin ne trouvait plus de `__pycache__` et la sonde criait « impossible » — or `prepublishOnly` lance
// la suite chez ce développeur, et la publication tombait sur un faux rouge. Les deux enfants de la
// sonde partent donc sans ce préfixe. (Les enfants ordinaires de `envPropre()` n'en ont pas besoin :
// `PYTHONDONTWRITEBYTECODE` l'emporte, Python n'écrit alors aucun cache, où que ce soit.)
test("la sonde du bytecode tient quand le développeur exporte PYTHONPYCACHEPREFIX — elle ne le laisse pas descendre à ses enfants", (t) => {
  const prefixe = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-pycacheprefix-"));
  const avant = process.env.PYTHONPYCACHEPREFIX;
  t.after(() => {
    if (avant === undefined) delete process.env.PYTHONPYCACHEPREFIX;
    else process.env.PYTHONPYCACHEPREFIX = avant;
    fs.rmSync(prefixe, { recursive: true, force: true });
  });
  process.env.PYTHONPYCACHEPREFIX = prefixe;

  sondeDuBytecode(t);
  assert.deepEqual(fs.readdirSync(prefixe), [], "les enfants de la sonde n'ont rien écrit sous le préfixe : il ne leur est pas descendu");

  // Le témoin de ce test-ci : sans le retrait, la variable du développeur change bien le résultat. Un
  // import qui AUTORISE le bytecode, avec le préfixe, n'écrit rien à côté de la source — il écrit sous le préfixe.
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-pycacheprefix-source-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dossier, "petit.py"), "VALEUR = 1\n");
  const importe = spawnSync("python3", ["-c", `import importlib.util,sys; s=importlib.util.spec_from_file_location('petit',${JSON.stringify(path.join(dossier, "petit.py"))}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)`],
    { encoding: "utf8", env: envPropre({ PYTHONDONTWRITEBYTECODE: "" }), cwd: dossier });
  assert.equal(importe.status, 0, importe.stderr);
  assert.equal(fs.existsSync(path.join(dossier, "__pycache__")), false, "sonde impossible : avec le préfixe, Python ne devait rien écrire à côté de la source");
  assert.notDeepEqual(fs.readdirSync(prefixe), [], "sonde impossible : avec le préfixe, Python devait écrire son cache sous lui");
});
