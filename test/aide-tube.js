// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UN VRAI TUBE, PAS UN TAMPON — la preuve qu'un texte arrive ENTIER dans un `| wc -c`.
//
// Un programme qui écrit puis appelle `process.exit()` aussitôt perd la fin de son texte sur un
// tube macOS (asynchrone) : l'écriture part en deux temps et la sortie emporte le second. Un
// `spawnSync` ne le reproduit PAS, son tube se vide à part : la preuve passe par un vrai tube de
// shell, `sh -c '… | wc -c'`, et se répète — la coupure tombe tantôt à 512 octets, tantôt à 1024.
//
// Le texte attendu vient de la MÊME commande redirigée vers un fichier (jamais tronqué) ; le code
// de sortie vient du shell, à côté du tube. Le flux éprouvé est seul dans le tube, l'autre part à
// la poubelle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre } from "./aide-env.js";

// `commande` est une ligne de shell déjà quotée (voir `quote`). Rend la longueur attendue (le fichier),
// son code, et les longueurs et codes lus par `repetitions` tubes.
export function enTubeReel(commande, { flux = "stdout", repetitions = 8, env = {}, cwd } = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-tube-reel-"));
  try {
    const rcFichier = path.join(dossier, "rc");
    const reference = path.join(dossier, "reference");
    const versLeTube = flux === "stderr" ? "2>&1 >/dev/null" : "2>/dev/null";
    const versLeFichier = flux === "stderr" ? `2>${quote(reference)} >/dev/null` : `2>/dev/null >${quote(reference)}`;
    const environnement = { ...envPropre(), CC2CC_V2_HOME: path.join(dossier, "bureau"), HOME: dossier, CC2CC_GARDE_BUREAU: "1", ...env };
    const lancer = (script) => spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: environnement, cwd });

    const versUnFichier = lancer(`{ ${commande} ${versLeFichier}; echo $? > ${quote(rcFichier)}; }`);
    if (versUnFichier.status !== 0) throw new Error(`le shell a échoué : ${versUnFichier.stderr}`);
    const attendu = fs.statSync(reference).size;
    const rcAttendu = Number(fs.readFileSync(rcFichier, "utf8").trim());

    const tailles = [];
    const codes = [];
    for (let i = 0; i < repetitions; i += 1) {
      const dansLeTube = lancer(`{ ${commande} ${versLeTube}; echo $? > ${quote(rcFichier)}; } | wc -c`);
      if (dansLeTube.status !== 0) throw new Error(`le shell a échoué : ${dansLeTube.stderr}`);
      tailles.push(Number(dansLeTube.stdout.trim()));
      codes.push(Number(fs.readFileSync(rcFichier, "utf8").trim()));
    }
    return { attendu, rcAttendu, tailles, codes };
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

// Une chaîne quotée pour `sh`.
export function quote(texte) {
  return `'${String(texte).replace(/'/g, "'\\''")}'`;
}
