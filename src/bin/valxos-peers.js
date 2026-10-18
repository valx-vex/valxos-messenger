#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// Les chaises du registre. Par défaut celles qui REÇOIVENT ; `--all` montre
// aussi les mortes et les retirées du service — rien n'est jamais effacé.
//
// PARSEARGS, ENFIN (review interne, vague suivante) : ce fichier avait le
// MÊME trou que facteur.js (un correctif antérieur), par une autre porte —
// `args.includes("--all")` sur l'argv BRUT, jamais parseArgs. "--all=true"
// ne matchait jamais la chaîne EXACTE "--all" : includeDead restait false,
// et l'outil rendait silencieusement la vue par défaut avec exit 0 — aucun
// refus, un JSON qui a l'air bon et ne l'est pas. (Ma propre phrase d'un
// correctif antérieur, « le SEUL des sept binaires » à échapper à parseArgs,
// était donc fausse — corrigée au commentaire de facteur.js, pas réécrite
// dans l'historique.) --all et --include-dead sont déclarés BOOLÉENS pour
// la même raison que sur facteur.js : aucun des deux n'attend de valeur.
import { getDatabase, lettresEnSouffrance, listPeers } from "../lib/database.js";
import { DEFAULT_ROSTER, seuilsDeSouffrance } from "../lib/config.js";
import { ficheLisible, pairsEtAlias } from "../lib/registry.js";
import { parseArgs, printJson } from "./cli-common.js";

const args = parseArgs(process.argv.slice(2), {
  booleans: ["all", "include_dead"],
  known: [],
  positionals: false,
  usage: "usage: valxos-peers [--all | --include-dead]"
});
const includeDead = args.all === true || args.include_dead === true;

const db = getDatabase();
// Les alias à côté des pairs, jamais parmi eux (Run 6, 27/09).
const { peers, aliases } = pairsEtAlias(db, listPeers(db, { includeDead }));
// Le roster ne compte comme « registered » que ce qui reçoit vraiment : c'est la
// seule lecture qui ne fasse pas écrire de lettre morte.
const enService = new Set(listPeers(db).map((peer) => peer.id));

// L'EN-SOUFFRANCE PAR FICHE (H2) : « à qui écrit-on dans le vide ? » se lit
// ICI, fiches mortes comprises — c'est la moitié « désignée-morte VISIBLE » du
// backlog du 20/08. Le compte est celui des lettres dont l'ENVELOPPE porte
// exactement ce nom (`recipient = fiche.id`) : les noms sans fiche restent
// l'affaire du doctor, et une lettre à une lignée ne se recompte pas sur
// chacune de ses chaises. `limit` est levée ici : le compte dit TOUT, jamais
// une borne silencieuse (même trou que le doctor, corrigé plus tôt).
const dettes = new Map();
for (const lettre of lettresEnSouffrance(db, { seuils: seuilsDeSouffrance(), limit: Number.MAX_SAFE_INTEGER })) {
  dettes.set(lettre.recipient, (dettes.get(lettre.recipient) || 0) + 1);
}
printJson({
  peers: peers.map((peer) => ({ ...ficheLisible(peer), en_souffrance: dettes.get(peer.id) || 0 })),
  aliases,
  include_dead: includeDead,
  roster: DEFAULT_ROSTER.map((id) => ({ id, registered: enService.has(id) }))
});
