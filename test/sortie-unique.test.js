// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UNE SEULE SORTIE, UN SEUL ENDROIT (Run 6, hygiène H2).
//
// Task 8 a posé le patron dans valxos-chaise.js et facteur.js : `sortir()`
// LÈVE une `Sortie`, le guichet rend un code, et UN `terminer()` attend que
// stdout et stderr aient tout écrit avant `process.exit`. Le patron était
// recopié mot pour mot dans les deux binaires : il vit désormais dans
// src/bin/cli-common.js, et l'audit des autres binaires a trouvé le même
// défaut de drain dans le point d'entrée valxos-messenger — son aide (plus de
// 512 octets) arrivait coupée à 512 sur n'importe quel tube, parce qu'un
// `process.exit()` suivait l'écriture.
//
// Aucun test ici n'ouvre de bureau : l'aide et le refus du point d'entrée ne
// touchent ni base ni disque.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { Sortie, executer, sortir, terminer } from "../src/bin/cli-common.js";
import { envPropre } from "./aide-env.js";
import { enTubeReel } from "./aide-tube.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const binaire = (nom) => path.join(repo, "src", "bin", nom);

test("cli-common exporte le patron : Sortie, sortir (lève), terminer, executer", () => {
  assert.equal(typeof terminer, "function");
  assert.equal(typeof executer, "function");
  assert.throws(() => sortir(3, "non"), (e) => e instanceof Sortie && e.code === 3 && e.message === "non");
});

test("valxos-chaise et facteur n'ont plus leur propre copie du patron", () => {
  for (const nom of ["valxos-chaise.js", "facteur.js"]) {
    const source = fs.readFileSync(binaire(nom), "utf8");
    assert.doesNotMatch(source, /class Sortie\b/, `${nom} redéfinit Sortie`);
    assert.doesNotMatch(source, /function terminer\b/, `${nom} redéfinit terminer`);
    assert.match(source, /from "\.\/cli-common\.js"/, `${nom} importe cli-common`);
  }
});

// Un vrai tube et un lecteur lent : le chemin du drain, pas un tampon mémoire.
function parUnTube(argv, { flux = "stdout" } = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-sortie-"));
  try {
    const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const rcFichier = path.join(dossier, "rc");
    const commande = `${q(process.execPath)} ${q(binaire("valxos-messenger.js"))} ${argv.map(q).join(" ")}`;
    // stderr seul dans le tube quand c'est lui qu'on éprouve.
    const redirection = flux === "stderr" ? "2>&1 >/dev/null" : "2>/dev/null";
    const script = `{ ${commande} ${redirection}; echo $? > ${q(rcFichier)}; } | (sleep 0.3; cat)`;
    const sortie = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: envPropre() });
    return { texte: sortie.stdout, rc: Number(fs.readFileSync(rcFichier, "utf8").trim()) };
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

test("valxos-messenger --help par un tube lent : l'aide ENTIÈRE, rc 0", () => {
  const { texte, rc } = parUnTube(["--help"]);
  assert.equal(rc, 0);
  assert.ok(Buffer.byteLength(texte) > 512, `l'aide dépasse 512 octets (${Buffer.byteLength(texte)})`);
  assert.match(texte, /valxos-messenger --help\n\s+Show this message\.\n$/, "l'aide arrive jusqu'à sa dernière ligne");
});

test("valxos-messenger sous-commande inconnue par un tube lent : refus + aide ENTIÈRE sur stderr, rc 2", () => {
  const { texte, rc } = parUnTube(["pas-une-commande"], { flux: "stderr" });
  assert.equal(rc, 2);
  assert.match(texte, /^Unknown subcommand: pas-une-commande\n/);
  assert.match(texte, /Show this message\.\n$/, "l'aide arrive jusqu'à sa dernière ligne");
});

// ── C2 (FIX-C, 18/10) — L'AIDE ET LE REFUS DE `parseArgs` NE SE COUPENT PLUS SUR UN TUBE ──
//
// `parseArgs` imprimait l'aide (ou le refus d'un drapeau inconnu, avec l'usage) puis
// appelait `process.exit` dans la foulée. Sous macOS un tube est asynchrone : l'écriture
// partait en deux temps, `process.exit` coupait le second — `valxos-chaise -h | wc -c` rendait
// 512 octets (parfois 1024) sur 1235, et l'erreur de `--bogus` 512 ou 1024 sur 1275. Un
// `spawnSync` seul ne le reproduit PAS (son tube se vide à part) : la preuve passe par un vrai
// tube de shell, `sh -c '… | wc -c'`, répété — la coupure tombait tantôt à 512, tantôt à 1024.
//
// Le texte part d'ICI, d'une fonction SYNCHRONE dont les appelants comptent sur le fait qu'elle
// ne rend jamais la main après un refus : on n'attend donc pas un rappel d'écriture, on écrit
// tout avant de sortir. Les deux sorties (stdout, stderr) et leurs codes (0, 2) sont tenus.
const chaise = (...argv) => `'${process.execPath}' '${binaire("valxos-chaise.js")}' ${argv.map((a) => `'${a}'`).join(" ")}`;

test("C2 — `valxos-chaise -h` dans un vrai tube : l'aide ENTIÈRE, huit fois sur huit, sortie 0", () => {
  const { attendu, rcAttendu, tailles, codes } = enTubeReel(chaise("-h"));
  assert.ok(attendu > 1024, `sonde impossible : l'aide ne dépasse plus 1024 octets (${attendu}), une coupure à 512 ou 1024 ne se verrait plus`);
  assert.equal(rcAttendu, 0);
  assert.deepEqual(tailles, Array(8).fill(attendu), "chaque lecture du tube donne l'aide entière");
  assert.deepEqual(codes, Array(8).fill(0), "et la sortie reste 0");
});

test("C2 — le refus d'un drapeau inconnu (stderr, usage compris) dans un vrai tube : entier, huit fois sur huit, sortie 2", () => {
  const { attendu, rcAttendu, tailles, codes } = enTubeReel(chaise("--bogus"), { flux: "stderr" });
  assert.ok(attendu > 1024, `sonde impossible : le refus ne dépasse plus 1024 octets (${attendu})`);
  assert.equal(rcAttendu, 2);
  assert.deepEqual(tailles, Array(8).fill(attendu), "chaque lecture du tube donne le refus entier, usage compris");
  assert.deepEqual(codes, Array(8).fill(2), "et la sortie reste 2");
});

// Le texte peut dépasser le tampon d'un tube (64 Ko) ET stdout peut déjà avoir été touché (donc
// passé en mode non bloquant) : l'écriture reçoit alors EAGAIN, et doit attendre le lecteur au
// lieu de jeter le reste. Un lecteur lent (`sleep 0.4`) force le tube à se remplir.
test("C2 — un texte plus grand que le tube, stdout déjà touché, lecteur lent : tout arrive, sortie 0 (EAGAIN attendu, pas jeté)", () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-tube-plein-"));
  try {
    const TAILLE = 300000;
    const programme =
      `import { parseArgs } from ${JSON.stringify(pathToFileURL(path.join(repo, "src", "bin", "cli-args.js")).href)};\n` +
      `process.stdout.write("");\n` + // touche stdout : le descripteur passe en non bloquant sur un tube
      `parseArgs(["-h"], { known: [], usage: "x".repeat(${TAILLE}) });\n` +
      `process.stdout.write("JAMAIS : parseArgs a rendu la main après -h\\n");\n`;
    const fichier = path.join(dossier, "sonde.mjs");
    fs.writeFileSync(fichier, programme);
    const rcFichier = path.join(dossier, "rc");
    const script = `{ '${process.execPath}' '${fichier}'; echo $? > '${rcFichier}'; } | (sleep 0.4; wc -c)`;
    const sortie = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...envPropre(), HOME: dossier } });
    assert.equal(sortie.status, 0, sortie.stderr);
    assert.equal(Number(sortie.stdout.trim()), TAILLE + 1, "le texte entier et son retour à la ligne, rien d'autre");
    assert.equal(Number(fs.readFileSync(rcFichier, "utf8").trim()), 0, "sortie 0, et parseArgs n'a jamais rendu la main");
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});
