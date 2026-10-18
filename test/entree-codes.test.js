// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE POINT D'ENTRÉE DIT LA VÉRITÉ SUR SON ENFANT (hygiène H8).
//
// `valxos-messenger install|uninstall|doctor` lance `node <script>` et
// rendait `code ?? 0` : un enfant tué par un signal sortait VERT, et un enfant
// qui ne démarrait même pas (aucun écouteur `error`) faisait mourir le parent
// sur une exception non gérée. Désormais : le code de l'enfant tel quel ; un
// signal se nomme sur stderr et sort 128 + son numéro ; un échec de lancement
// se dit et sort 2.
//
// L'ENFANT EST UN FAUX SCRIPT, LANCÉ PAR LE VRAI NODE (F10). Le point
// d'entrée lance `process.execPath`, plus un `node` du PATH : un faux node
// posé sur un PATH jetable ne serait plus jamais appelé. Le banc copie donc le
// point d'entrée (et ce qu'il importe) dans un paquet jetable dont
// `scripts/install.js` et `src/bin/valxos-doctor.js` sont des faux : aucun
// installeur réel ne tourne ici, et le HOME est celui de fauxHome.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { environnement, fauxHome, repo } from "./aide-installeur.js";

function paquetFactice(t, corpsEnfant) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-entree-"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  for (const rel of ["src/bin/valxos-messenger.js", "src/bin/cli-common.js", "src/bin/cli-args.js", "src/lib/config.js"]) {
    fs.mkdirSync(path.dirname(path.join(racine, rel)), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), path.join(racine, rel));
  }
  fs.writeFileSync(path.join(racine, "package.json"), JSON.stringify({ type: "module" }));
  fs.mkdirSync(path.join(racine, "scripts"), { recursive: true });
  for (const rel of ["scripts/install.js", "src/bin/valxos-doctor.js"]) fs.writeFileSync(path.join(racine, rel), `${corpsEnfant}\n`);
  return racine;
}

function entree(t, home, args, corpsEnfant) {
  const racine = paquetFactice(t, corpsEnfant);
  return spawnSync(process.execPath, [path.join(racine, "src", "bin", "valxos-messenger.js"), ...args], {
    encoding: "utf8",
    cwd: racine,
    env: environnement(home, { PATH: "/bin:/usr/bin" })
  });
}

test("un enfant qui sort 3 → le point d'entrée sort 3", (t) => {
  const home = fauxHome(t);
  const sortie = entree(t, home, ["install", "--dry-run"], "process.exit(3);");
  assert.equal(sortie.status, 3, sortie.stderr);
});

test("un enfant qui sort 0 → 0 (le chemin sain)", (t) => {
  const home = fauxHome(t);
  assert.equal(entree(t, home, ["doctor"], "process.exit(0);").status, 0);
});

test("un enfant tué par SIGTERM → 143, et le signal est nommé sur stderr", (t) => {
  const home = fauxHome(t);
  const sortie = entree(t, home, ["uninstall"], "process.kill(process.pid, 'SIGTERM');");
  assert.equal(sortie.status, 143, sortie.stderr);
  assert.match(sortie.stderr, /SIGTERM/);
});

test("un enfant tué par SIGKILL → 137", (t) => {
  const home = fauxHome(t);
  const sortie = entree(t, home, ["doctor"], "process.kill(process.pid, 'SIGKILL');");
  assert.equal(sortie.status, 137, sortie.stderr);
  assert.match(sortie.stderr, /SIGKILL/);
});

// Un enfant qui ne peut pas démarrer : avec `process.execPath`, plus aucun
// PATH ne peut le provoquer (c'était le banc d'avant F10). L'écouteur `error`
// reste (un exécutable retiré sous nos pieds) ; ce qu'on prouve ici, c'est
// qu'un enfant qui plante au démarrage rend son code, jamais un vert.
test("un enfant qui plante au démarrage → son code non nul, jamais 0", (t) => {
  const home = fauxHome(t);
  const sortie = entree(t, home, ["install", "--dry-run"], "throw new Error('boum');");
  assert.equal(sortie.status, 1, `${sortie.stdout}\n${sortie.stderr}`);
  assert.match(sortie.stderr, /boum/);
});

// F10 (passe adverse du Run 6, 28/09) — L'ENFANT TOURNE SOUS LE NODE QUI
// TOURNE, jamais sous un `node` trouvé sur le PATH. Sous nvm, `npx -p node@X`
// ou un mélange Homebrew/système, l'installeur tournait sous un autre Node que
// celui qui a construit better-sqlite3 ; sans node sur le PATH, il ne
// démarrait pas du tout.
test("F10 — sans aucun node sur le PATH, install --dry-run tourne quand même (process.execPath)", (t) => {
  const home = fauxHome(t);
  const sortie = spawnSync(process.execPath, [path.join(repo, "src", "bin", "valxos-messenger.js"), "install", "--dry-run"], {
    encoding: "utf8", cwd: repo, env: environnement(home, { PATH: "/usr/bin:/bin" })
  });
  assert.doesNotMatch(sortie.stderr, /could not start/i, sortie.stderr);
  assert.equal(sortie.status, 0, `${sortie.stdout}\n${sortie.stderr}`);
});
