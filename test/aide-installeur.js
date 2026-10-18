// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE HARNAIS DES TESTS DE L'INSTALLEUR — un vrai sous-processus, un faux HOME.
//
// Chaque test qui lance `scripts/install.js` le fait ici : dans un HOME né
// sous mkdtemp, avec un bureau posé EXPLICITEMENT dedans, et un PATH qui ne
// contient que `node`. Ni `claude` ni `npm` ne se trouvent d'ici : l'intégration
// Claude Code est optionnelle et l'installeur doit le dire sans l'exécuter, et
// un `npm install` réel n'a rien à faire dans une suite de tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { envPropre } from "./aide-env.js";

export const repo = path.resolve(new URL("..", import.meta.url).pathname);

export function fauxHome(t) {
  // Le chemin RÉEL : sur macOS, os.tmpdir() est un lien (/var → /private/var)
  // et un `$PWD` lu par un sous-processus, lui, dit le chemin résolu.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-install-")));
  fs.mkdirSync(path.join(home, "bin"));
  fs.symlinkSync(process.execPath, path.join(home, "bin", "node"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

export function environnement(home, ajouts = {}) {
  const env = {
    ...envPropre(),
    HOME: home,
    VALXOS_MESSENGER_HOME: path.join(home, ".valxos-messenger"),
    PATH: path.join(home, "bin")
  };
  for (const clef of ["CLAUDE_CONFIG_DIR", "CC2CC_V2_HOME", "CC2CC_GARDE_BUREAU", "VALXOS_GARDE_BUREAU"]) {
    delete env[clef];
  }
  return { ...env, ...ajouts };
}

// Lance l'installeur du dépôt — ou celui d'une COPIE du paquet (`racine`),
// quand c'est la situation du paquet qu'on veut éprouver.
export function lancer(home, args, ajouts = {}, { racine = repo } = {}) {
  // TROIS ISSUES : sans node_modules, l'installeur du dépôt chercherait un
  // `npm` que ce PATH ne connaît pas — chaque verdict serait un rouge trompeur.
  if (racine === repo) {
    assert.ok(fs.existsSync(path.join(repo, "node_modules")), "SONDE IMPOSSIBLE : node_modules absent du dépôt sous test");
  }
  return spawnSync(process.execPath, [path.join(racine, "scripts", "install.js"), ...args], {
    encoding: "utf8",
    cwd: racine,
    env: environnement(home, ajouts)
  });
}

// Le rapport machine suit le résumé humain : c'est le premier bloc qui
// commence par une accolade en tête de ligne.
export function rapport(sortie) {
  const debut = sortie.stdout.search(/^\{/m);
  assert.ok(debut >= 0, `pas de rapport JSON dans :\n${sortie.stdout}\n${sortie.stderr}`);
  return JSON.parse(sortie.stdout.slice(debut));
}

export function arbre(home) {
  return execFileSync("find", [home], { encoding: "utf8" }).trim().split("\n").sort();
}

// Le paquet tel qu'il est publié : les fichiers suivis par git, tels qu'ils
// sont SUR LE DISQUE (le code sous test, pas le dernier commit), sans node_modules.
export function copieDuPaquet(destination) {
  const suivis = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(suivis.length > 50, `SONDE IMPOSSIBLE : ${suivis.length} fichiers suivis seulement`);
  for (const rel of suivis) {
    const source = path.join(repo, rel);
    if (!fs.existsSync(source)) continue;
    const cible = path.join(destination, rel);
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.copyFileSync(source, cible);
  }
  assert.ok(fs.existsSync(path.join(destination, "scripts", "install.js")), "SONDE IMPOSSIBLE : la copie n'a pas d'installeur");
  return destination;
}

// UN FAUX LAUNCHCTL OÙ RIEN N'EST CHARGÉ : `print` répond 113 (« Could not
// find service ») pour tout label, tout autre verbe sort 0 et se note. Sans lui,
// ce PATH (node seul) ne trouve aucun launchctl et chaque --uninstall prend la
// branche « sonde impossible » (Task 9) : les tests qui veulent le chemin « ok »
// le posent EXPRÈS (hygiène H3). `appels()` rend les gestes, sondes exclues.
export function launchctlOuRienNestCharge(home) {
  const journal = path.join(home, "launchctl-vide.journal");
  const script = path.join(home, "faux-launchctl-vide");
  fs.writeFileSync(
    script,
    "#!/bin/sh\n" +
      `printf '%s\\t' "$@" >> ${JSON.stringify(journal)}; printf '\\n' >> ${JSON.stringify(journal)}\n` +
      "if [ \"$1\" = print ]; then exit 113; fi\nexit 0\n",
    { mode: 0o755 }
  );
  const tout = () =>
    fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").map((ligne) => ligne.split("\t").filter(Boolean))
      : [];
  return { script, appels: () => tout().filter((a) => a[0] !== "print"), sondes: () => tout().filter((a) => a[0] === "print") };
}
