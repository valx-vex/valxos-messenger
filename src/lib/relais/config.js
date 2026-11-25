// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA CONFIGURATION DU RELAIS — `<racine>/relais.json`.
//
// Le relais porte les lettres entre deux Macs. Ce fichier dit qui je suis
// (`moi`) et où sont les autres (`macs`). Absent, il n'y a pas de relais : on
// rend `null`, ce n'est pas une panne. Présent mais faux, on refuse en nommant
// le défaut : un relais qui part avec un chemin `~` ou un Mac sans `ssh`
// échouerait plus loin, à distance, sans qu'on sache pourquoi.
import fs from "node:fs";
import path from "node:path";

export const INTERVALLE_PAR_DEFAUT_MS = 2000;
const CHEMINS = ["node", "depot", "bureau"];

function invalide(message) {
  const erreur = new Error(`invalid relais.json: ${message}`);
  erreur.code = "config-relais-invalide";
  return erreur;
}

const texte = (v) => typeof v === "string" && v.trim().length > 0;

export function lireLaConfigDuRelais(racine) {
  const fichier = path.join(racine, "relais.json");
  let brut;
  try {
    brut = fs.readFileSync(fichier, "utf8");
  } catch (erreur) {
    if (erreur?.code === "ENOENT") return null;
    throw erreur;
  }
  let json;
  try {
    json = JSON.parse(brut);
  } catch (erreur) {
    throw invalide(`unreadable JSON (${erreur.message})`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw invalide("the root object is missing");
  if (!texte(json.moi)) throw invalide("`moi` is missing");
  const macsBruts = json.macs ?? {};
  if (typeof macsBruts !== "object" || macsBruts === null || Array.isArray(macsBruts)) {
    throw invalide("`macs` must be an object");
  }
  const macs = {};
  for (const [nom, mac] of Object.entries(macsBruts)) {
    if (nom === json.moi) throw invalide(`\`macs\` must not contain "${nom}": it is this Mac (\`moi\`)`);
    if (!mac || typeof mac !== "object") throw invalide(`Mac "${nom}" must be an object`);
    for (const clef of ["ssh", ...CHEMINS]) {
      if (!texte(mac[clef])) throw invalide(`Mac "${nom}" has no \`${clef}\``);
    }
    for (const clef of CHEMINS) {
      if (!mac[clef].startsWith("/")) {
        throw invalide(`Mac "${nom}": \`${clef}\` must be an absolute path ("${mac[clef]}")`);
      }
    }
    macs[nom] = { ssh: mac.ssh, node: mac.node, depot: mac.depot, bureau: mac.bureau };
  }
  let intervalle_ms = INTERVALLE_PAR_DEFAUT_MS;
  if (json.intervalle_ms !== undefined) {
    if (!Number.isFinite(json.intervalle_ms) || json.intervalle_ms <= 0) {
      throw invalide("`intervalle_ms` must be a positive number");
    }
    intervalle_ms = json.intervalle_ms;
  }
  return { moi: json.moi, macs, intervalle_ms };
}
