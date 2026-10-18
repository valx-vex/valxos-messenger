// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'AIDE QUI DÉCOUVRE LES IDENTITÉS — testée avec un FAUX `tailscale` sur le
// PATH, jamais avec le vrai : ce que le démon dit change d'une machine à
// l'autre, ce que l'aide en fait ne doit pas.
//
// Les valeurs de FORME (un nom *.ts.net, une adresse 100.x.x.x) se construisent
// à l'exécution : ce fichier est scanné par les gardes comme les autres, il ne
// doit pas porter lui-même un motif de forme.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { identitesDeCetteMachine, modeCI } from "./aide-identites.js";

// Un `tailscale` de carton qui imprime ce qu'on lui dit, en tête du PATH.
function fauxTailscale(sortie) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aide-identites-faux-ts-"));
  const fichierSortie = path.join(dir, "sortie.json");
  fs.writeFileSync(fichierSortie, sortie);
  // `/bin/cat` en absolu : l'enfant ne reçoit que le PATH du carton.
  fs.writeFileSync(path.join(dir, "tailscale"), `#!/bin/sh\n/bin/cat "${fichierSortie}"\n`, { mode: 0o755 });
  return { PATH: dir };
}

const RESEAU = ["reseau-zorglub", "ts", "net"].join(".");
const DNS = (nom) => `${nom}.${RESEAU}.`; // le point final, comme le vrai démon l'écrit
const ADRESSE = (fin) => [100, 99, 98, fin].join(".");

const ETAT = JSON.stringify({
  Self: { HostName: "poste-zorglub", DNSName: DNS("poste-zorglub"), TailscaleIPs: [ADRESSE(97)] },
  MagicDNSSuffix: RESEAU,
  Peer: { clef: { HostName: "pair-zorglub", DNSName: DNS("pair-zorglub"), TailscaleIPs: [ADRESSE(96)] } }
});

test("B3 : un `tailscale status --json` qui imprime `null` ne fait pas tomber la découverte — il n'y a simplement rien", () => {
  const env = fauxTailscale("null\n");
  const identites = identitesDeCetteMachine({ env });
  assert.ok(identites.length >= 3, "compte, machine et domicile se découvrent toujours");
  assert.equal(identites.filter((i) => i.source === "tailscale").length, 0, "et rien ne vient de tailscale");
});

test("B3 : une sortie qui n'est pas du JSON ne fait pas tomber la découverte non plus", () => {
  const env = fauxTailscale("Tailscale is stopped.\n");
  assert.ok(identitesDeCetteMachine({ env }).length >= 3);
});

test("ce que l'aide tire de tailscale : cette machine, son nom DNS et ses labels, ses adresses, chaque pair — source nommée", () => {
  const env = fauxTailscale(ETAT);
  const valeurs = new Map(identitesDeCetteMachine({ env }).filter((i) => i.source === "tailscale").map((i) => [i.valeur, i.quoi]));
  for (const attendue of ["poste-zorglub", DNS("poste-zorglub").replace(/\.$/, ""), "reseau-zorglub", RESEAU, ADRESSE(97), "pair-zorglub", ADRESSE(96)]) {
    assert.ok(valeurs.has(attendue), `identité attendue de tailscale : ${attendue}`);
  }
  assert.ok(![...valeurs.keys()].some((v) => v === "ts" || v === "net"), "les labels génériques n'entrent pas");
});

test("chaque identité dit d'où elle vient — le compte, la machine et le domicile viennent du système", () => {
  const env = fauxTailscale("null\n");
  const sources = new Set(identitesDeCetteMachine({ env }).map((i) => i.source));
  for (const attendue of ["compte", "machine", "domicile"]) assert.ok(sources.has(attendue), `source attendue : ${attendue}`);
});

// LE MODE CI (Run 6, ruling 10). Dans GitHub Actions, le compte s'appelle
// « runner », le domicile est celui du runner, la machine est jetable : les
// chercher dans l'arbre accusait chaque commentaire qui parle du « runner » de
// `node --test` (19 fuites fantômes, main rouge le 27/09). Le mode s'ALLUME
// seulement si on le demande ET qu'on est dans GitHub Actions — jamais par
// une seule variable qu'un lanceur local poserait par erreur.
test("modeCI : vrai seulement quand le mode est demandé ET que GitHub Actions tourne", () => {
  assert.equal(modeCI({ VALXOS_GARDES_MODE: "ci", GITHUB_ACTIONS: "true" }), true);
  assert.equal(modeCI({ VALXOS_GARDES_MODE: "ci" }), false);
  assert.equal(modeCI({ GITHUB_ACTIONS: "true" }), false);
  assert.equal(modeCI({ VALXOS_GARDES_MODE: "CI", GITHUB_ACTIONS: "true" }), false, "la valeur exacte, pas une approximation");
  assert.equal(modeCI({}), false);
});

test("mode CI : le compte, la machine et le domicile du runner ne sont pas des identités de la maison", () => {
  const sources = new Set(identitesDeCetteMachine({ env: { ...process.env, VALXOS_GARDES_MODE: "ci", GITHUB_ACTIONS: "true" } }).map((i) => i.source));
  for (const s of ["compte", "machine", "domicile"]) assert.ok(!sources.has(s), s);
});

test("mode CI demandé hors GitHub Actions : refusé, les gardes restent entières", () => {
  const env = { ...process.env, VALXOS_GARDES_MODE: "ci" };
  delete env.GITHUB_ACTIONS;
  const sources = new Set(identitesDeCetteMachine({ env }).map((i) => i.source));
  for (const s of ["compte", "machine", "domicile"]) assert.ok(sources.has(s), s);
});
