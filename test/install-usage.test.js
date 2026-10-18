// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'INSTALLEUR REFUSE CE QU'IL NE CONNAÎT PAS — et il a un mode d'emploi.
//
// L'incident du 27/09 : `node scripts/install.js --help` a fait une VRAIE
// install depuis un worktree — l'installeur ignorait les drapeaux inconnus et
// retombait sur l'install par défaut. Désormais `--help`/`-h` imprime l'usage
// et sort 0 ; tout drapeau inconnu imprime « unknown flag » + l'usage et sort 2,
// AVANT le moindre effet sur le disque.
//
// Tout se joue dans un HOME jetable (test/aide-installeur.js).
import test from "node:test";
import assert from "node:assert/strict";
import { arbre, fauxHome, lancer, rapport } from "./aide-installeur.js";

for (const drapeau of ["--help", "-h"]) {
  test(`${drapeau} imprime l'usage, sort 0, et ne touche à rien`, (t) => {
    const home = fauxHome(t);
    const avant = arbre(home);
    const sortie = lancer(home, [drapeau]);
    assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
    assert.match(sortie.stdout, /usage:/i);
    for (const connu of ["--dry-run", "--uninstall", "--force", "--no-enable", "--launchd", "--launchd-load", "--launchd-unload", "--operator"]) {
      assert.ok(sortie.stdout.includes(connu), `l'usage nomme ${connu} :\n${sortie.stdout}`);
    }
    assert.ok(!/Install summary/.test(sortie.stdout), "aucune install derrière --help");
    assert.deepEqual(arbre(home), avant, "l'arbre du HOME est inchangé");
  });
}

test("--help gagne même à côté d'un drapeau d'action", (t) => {
  const home = fauxHome(t);
  const avant = arbre(home);
  const sortie = lancer(home, ["--no-enable", "--help"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stdout, /usage:/i);
  assert.deepEqual(arbre(home), avant);
});

for (const args of [["--halp"], ["--no-enable", "--halp"], ["--dry-run=1"], ["install"], ["-x"]]) {
  test(`${args.join(" ")} : refusé (rc 2), usage imprimé, rien créé`, (t) => {
    const home = fauxHome(t);
    const avant = arbre(home);
    const sortie = lancer(home, args);
    assert.equal(sortie.status, 2, `${sortie.stdout}\n${sortie.stderr}`);
    const inconnu = args.find((a) => a !== "--no-enable");
    assert.ok(sortie.stderr.includes(`unknown flag: ${inconnu}`), sortie.stderr);
    assert.match(sortie.stderr, /usage:/i);
    assert.ok(!/Install summary/.test(sortie.stdout), sortie.stdout);
    assert.deepEqual(arbre(home), avant, "l'arbre du HOME est inchangé");
  });
}

test("une combinaison valide passe toujours : --dry-run --launchd --operator alice", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run", "--launchd", "--operator", "alice"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.equal(rapport(sortie).launchd.operator, "alice");
});

test("une combinaison valide passe toujours : --dry-run --launchd --operator=bob", (t) => {
  const home = fauxHome(t);
  const sortie = lancer(home, ["--dry-run", "--launchd", "--operator=bob"]);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
  assert.equal(rapport(sortie).launchd.operator, "bob");
});
