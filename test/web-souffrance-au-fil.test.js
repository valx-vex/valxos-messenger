// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// H2 AU FIL — UNE LETTRE QUI BASCULE EN SOUFFRANCE PENDANT QUE LA PAGE EST
// OUVERTE DOIT LE DIRE À L'ÉCRAN.
//
// Le miroir exact de la bloquante du front (« la boîte crie, la lettre reste
// muette ») : l'en-souffrance d'une lettre est bien rendue à la RELÈVE
// (`/api/fil`), mais le flux ne la portait jamais. Le tour de scrutation ne
// comparait qu'`etatDeLaLettre` — les quatre mots — et l'en-souffrance est
// ORTHOGONALE à ces quatre-là (doctrine de format.js) : une lettre « en
// attente » qui devient en souffrance reste « en attente ». Rien ne changeait,
// donc rien ne partait.
//
// Ce que ça coûtait, en une phrase : la page de l'opérateur est ouverte, la
// quatrième heure passe, la lettre se met à crier — et il faut qu'il recharge
// pour l'apprendre. C'est TOUT l'intérêt du chantier H2, et c'est exactement le
// genre d'événement qu'un flux existe pour porter.
//
// ⚠️ POURQUOI LE DÉCOR VIEILLIT LA LETTRE EN BASE PLUTÔT QUE D'ATTENDRE QUATRE
// HEURES : l'en-souffrance est un VERDICT DÉRIVÉ (`created_at` contre le seuil
// d'âge), jamais un état stocké. Reculer `created_at` d'un flux ouvert, c'est
// exactement ce que fait le temps qui passe — et ça ne touche à AUCUN des
// quatre états, ce qui est précisément le piège qu'on veut tendre.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-souffrance-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { seuilsDeSouffrance } from "../src/lib/config.js";
import { insertMessage } from "../src/lib/database.js";
import { etatDeLaLettre } from "../src/lib/format.js";
import { registerInstance } from "../src/lib/registry.js";
import { MOI, bureauJetable, cookieDePremiereVisite, fluxSSE, porteDeTest } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// Le temps qui passe, écrit en base. Deux fois le seuil : la lettre est en
// souffrance sans discussion, et le test ne dépend pas d'une milliseconde.
function vieillirLaLettre(db, msgId) {
  const seuils = seuilsDeSouffrance();
  const vieux = new Date(Date.now() - 2 * Number(seuils.ageMs)).toISOString();
  db.prepare("UPDATE messages SET created_at = ? WHERE msg_id = ?").run(vieux, msgId);
  return vieux;
}

test("H2 AU FIL : une lettre qui bascule en souffrance PENDANT que la page est ouverte le dit au flux", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });

  // Une lettre de l'opérateur, toute neuve : personne ne crie encore.
  const lettre = insertMessage(db, {
    msg_id: "m-qui-va-crier",
    sender: MOI,
    recipient: "bob-eternal",
    subject: "tu dors ?",
    body: "je te laisse ça pour le réveil"
  });
  const etatAvant = etatDeLaLettre(lettre);

  const { base } = await porteDeTest(t, { db, periodeMs: 25 });
  const { cookie } = await cookieDePremiereVisite(base);
  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre((e) => e.type === "pairs");

  // Rien ne crie AVANT : sinon l'événement qu'on va attendre pourrait être un
  // reste du premier tour, et le test ne prouverait rien.
  assert.ok(
    !flux.evenements.some((e) => e.donnees?.en_souffrance),
    `une lettre criait déjà avant l'heure : ${JSON.stringify(flux.evenements.map((e) => e.type))}`
  );

  // LA QUATRIÈME HEURE PASSE, LA PAGE EST OUVERTE.
  vieillirLaLettre(db, "m-qui-va-crier");

  const cri = await flux.attendre((e) => e.donnees?.msg_id === "m-qui-va-crier" && e.donnees?.en_souffrance);
  assert.equal(cri.type, "etat", "le cri voyage sur `etat` — le front sait déjà repeindre une lettre qu'il connaît");
  assert.equal(cri.donnees.en_souffrance.tentatives, 0, "aucune tentative : c'est l'ÂGE qui l'a fait crier");
  assert.ok(
    Number(cri.donnees.en_souffrance.depuis_h) >= 4,
    `la lettre attend depuis ${cri.donnees.en_souffrance.depuis_h} h — le cri doit porter son âge`
  );
  assert.equal(
    cri.donnees.etat,
    etatAvant,
    "et AUCUN des quatre états n'a bougé : c'est bien l'orthogonalité qui rendait le défaut invisible"
  );

  flux.fermer();
});

test("H2 AU FIL : le cri ne se répète pas à chaque tour — un flux qui bégaie est un flux qu'on cesse de lire", async (t) => {
  const db = bureauJetable(t);
  registerInstance(db, { lineage: "bob-eternal", sessionId: "s-bob", house: "/maison/claude", pid: 4242 });
  insertMessage(db, {
    msg_id: "m-deja-vieille",
    sender: MOI,
    recipient: "bob-eternal",
    subject: "hier",
    body: "celle-là crie déjà"
  });
  vieillirLaLettre(db, "m-deja-vieille");

  const { base } = await porteDeTest(t, { db, periodeMs: 20 });
  const { cookie } = await cookieDePremiereVisite(base);
  const flux = fluxSSE(base, { cookie });
  await flux.pret;
  await flux.attendre((e) => e.type === "pairs");

  // Une lettre DÉJÀ en souffrance à l'ouverture n'est pas une nouvelle : la
  // page a `/api/fil` pour son état initial, le flux ne porte que ce qui
  // CHANGE. Vingt tours passent, et il ne doit rien répéter.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const cris = flux.evenements.filter((e) => e.donnees?.msg_id === "m-deja-vieille");
  assert.deepEqual(
    cris,
    [],
    `le flux a rejoué ${cris.length} fois une souffrance que la page connaissait déjà : ${JSON.stringify(cris.map((c) => c.type))}`
  );

  flux.fermer();
});
