// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PARITÉ DES SURFACES — casser la loi au guichet doit rougir AUSSI par le CLI.
//
// ⚠️ POURQUOI CE FICHIER EXISTE (trouvaille ②, 22/08). `src/bin/valxos-send.js`
// est un binaire PUBLIÉ (`bin.cc2cc-send`) et il refaisait de sa propre main
// les quatre gestes d'un envoi — insertMessage, la résolution, le réveil,
// l'avis — donc les trois remèdes (C1, C2, R2) en deuxième exemplaire. Preuve
// du coût, mesurée avant le remède : casser R2 DANS le guichet faisait tomber
// le test du guichet et laissait VERT « le rejeu d'un msg_id connu dit vrai
// aussi par le CLI » (test/rejeu-idempotent.test.js) — cette surface-là pouvait
// mentir seule, sans un mot. Et le seul test de parité existant
// (test/attente-visible.test.js) ne comparait qu'un TEXTE d'avis, jamais les
// gestes.
//
// ⚠️ CE QUI FAIT ORACLE ICI. Ce ne sont PAS les égalités entre les deux
// surfaces : « MCP == CLI » reste vert le jour où les deux se cassent ensemble,
// et c'est exactement ce qui arriverait pour une régression du guichet, qu'ils
// partagent désormais. L'oracle, ce sont les valeurs ABSOLUES attendues sur le
// chemin CLI — la porte à laquelle on frappe, l'avis rendu, le destinataire
// annoncé. Les égalités viennent après, comme témoin que la convergence tient.
//
// ⚠️ Base JETABLE (mkdtemp + CC2CC_V2_HOME) : le bureau vivant (~/.cc2cc-v2)
// n'est jamais ouvert ici (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { insertMessage, openDatabase } from "../src/lib/database.js";
import { instanceId, registerInstance } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-parite-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-parite-"));
}

// Le décor FANTÔME, celui qui sépare vraiment les deux mondes. Un décor
// tout-vivant ne prouverait rien : `porteDeReveil` IGNORE son argument
// destinataire quand la résolution a exactement une cible (registry.js:723-726),
// et une lettre détournée frapperait quand même à la bonne porte, par accident.
// Avec un destinataire que PERSONNE ne résout, la résolution a zéro cible et la
// porte est le nom TEL QU'IL EST DONNÉ — le détournement devient visible.
const FANTOME = "ghost-parite";
const VIVANTE = "vivante-parite";

function decor() {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, {
    lineage: VIVANTE,
    sessionId: "aaaa1111-0000-4000-8000-000000000001",
    house: "/maison/nulle-part",
    pid: process.pid
  });
  db.close();
  return root;
}

function envoyerParLeCLI(root, args) {
  return JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-send.js"), ...args], {
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-parite" }
    })
  );
}

test("le CLI tient R2 PAR LE GUICHET : le rejeu frappe chez le fantôme, jamais chez le nom qu'on vient de taper", (t) => {
  const root = decor();

  const premier = envoyerParLeCLI(root, ["--to", FANTOME, "--body", "au fantôme", "--msg-id", "parite-1"]);
  assert.equal(premier.sent, true, "l'avis ne casse JAMAIS la prise en charge (A9)");
  assert.equal(premier.to, FANTOME);
  assert.equal(premier.attente.motif, "destinataire-inconnu", "le décor ne vaut QUE si le fantôme est vraiment introuvable");
  assert.equal(premier.rejeu, undefined, "un envoi neuf ne porte pas de rejeu");

  // LE REJEU : même msg_id, et cette fois une lignée PARFAITEMENT vivante.
  const second = envoyerParLeCLI(root, ["--to", VIVANTE, "--body", "détourné", "--msg-id", "parite-1"]);

  assert.equal(second.to, FANTOME, "la ligne EXISTANTE parle — jamais le `--to` de cet appel-ci");
  assert.equal(
    path.basename(second.wake.socketPath),
    `${FANTOME}.sock`,
    "le réveil frappe à la porte du FANTÔME : frapper chez la vivante réveillerait quelqu'un pour une lettre qui n'est pas la sienne"
  );
  assert.equal(
    second.attente.motif,
    "destinataire-inconnu",
    "l'avis parle de la lettre EN BASE — un avis nul dirait au posteur que tout va bien"
  );
  assert.deepEqual(second.rejeu, { motif: "msg_id-deja-connu", demande: VIVANTE });
});

test("le MCP et le CLI rendent les MÊMES gestes sur le MÊME décor — une seule loi, deux surfaces", async (t) => {
  const rootCli = decor();
  const rootMcp = decor();

  envoyerParLeCLI(rootCli, ["--to", FANTOME, "--body", "au fantôme", "--msg-id", "parite-2"]);
  const parLeCLI = envoyerParLeCLI(rootCli, ["--to", VIVANTE, "--body", "détourné", "--msg-id", "parite-2"]);

  const client = new Client({ name: "cc2cc-parite-mcp", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: rootMcp, CC2CC_SELF: "posteur-parite" }
  });
  await client.connect(transport);
  let parLeMCP;
  try {
    await client.callTool({
      name: "send",
      arguments: { to: FANTOME, body: "au fantôme", msg_id: "parite-2" }
    });
    const reponse = await client.callTool({
      name: "send",
      arguments: { to: VIVANTE, body: "détourné", msg_id: "parite-2" }
    });
    parLeMCP = JSON.parse(reponse.content[0].text);
  } finally {
    await client.close();
  }

  // D'ABORD l'oracle absolu, des DEUX côtés — sans lui, les égalités qui
  // suivent seraient vertes le jour où les deux surfaces se cassent ensemble.
  for (const [surface, sortie, destinataire] of [
    ["CLI", parLeCLI, parLeCLI.to],
    ["MCP", parLeMCP, parLeMCP.recipient]
  ]) {
    assert.equal(destinataire, FANTOME, `${surface} : la ligne existante parle`);
    assert.equal(path.basename(sortie.wake.socketPath), `${FANTOME}.sock`, `${surface} : on frappe chez le fantôme`);
    assert.equal(sortie.attente.motif, "destinataire-inconnu", `${surface} : l'avis parle de la lettre en base`);
    assert.deepEqual(sortie.rejeu, { motif: "msg_id-deja-connu", demande: VIVANTE }, `${surface} : le rejeu s'annonce`);
  }

  // ENSUITE la parité, comme témoin que la convergence tient — le champ du
  // destinataire porte un nom différent d'une surface à l'autre (`to` côté CLI,
  // `recipient` côté MCP), c'est de la mise en forme et ça reste à chacun.
  assert.deepEqual(parLeCLI.attente, parLeMCP.attente, "le même avis, mot pour mot");
  assert.deepEqual(parLeCLI.rejeu, parLeMCP.rejeu, "la même annonce de rejeu");
  assert.equal(
    path.basename(parLeCLI.wake.socketPath),
    path.basename(parLeMCP.wake.socketPath),
    "la même porte de réveil"
  );
});

// ── L'ACCUSÉ : `valxos-inbox --ack` ET L'OUTIL MCP `ack` RENDENT LE MÊME VERDICT ──
//
// A3 (revue de l'inconnu F4, 18/10) a donné un accusé à la CLI. La règle d'un
// accusé est la plus gardée du dépôt (seul `acked_at` est terminal : signé par
// la mauvaise main, une lettre DISPARAÎT) — elle ne s'écrit pas deux fois. La
// CLI appelle les mêmes fonctions que l'outil MCP (`verifierIdentiteDeclaree`,
// `ackMessage`) ; ce test éprouve le RÉSULTAT : le même décor, les deux
// surfaces, le même verdict, jusqu'à la raison. Les valeurs absolues d'abord
// (une dérive commune aux deux ne doit pas rester verte), l'égalité ensuite.
const SESSION_PA = "aaaa2222-0000-4000-8000-000000000001";

function decorAccuse() {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const chaise = registerInstance(db, { lineage: "alice-pb", sessionId: SESSION_PA, house: "/maison/nulle-part", pid: process.pid }).id;
  insertMessage(db, { msg_id: "PA-nu", sender: "x", recipient: "alice-pa", body: "à alice (nom nu)" });
  insertMessage(db, { msg_id: "PA-chaise", sender: "x", recipient: chaise, body: "à la chaise" });
  db.close();
  return { root, chaise };
}

function accuserParLaCLIEnParite(root, appelant, msgId, declare) {
  const args = ["--ack", msgId, ...(declare ? ["--self", declare] : [])];
  const sortie = spawnSync("node", [path.join(repo, "src/bin/valxos-inbox.js"), ...args], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: appelant }
  });
  return JSON.parse(sortie.stdout);
}

async function accuserParLeMCP(root, appelant, msgId, declare) {
  const client = new Client({ name: "cc2cc-parite-ack", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: appelant }
  });
  await client.connect(transport);
  try {
    const reponse = await client.callTool({ name: "ack", arguments: { msg_id: msgId, ...(declare ? { self: declare } : {}) } });
    return JSON.parse(reponse.content[0].text);
  } finally {
    await client.close();
  }
}

// Ce qui fait le VERDICT : accusé ou non, quelle garde a mordu, pourquoi, qui et pour qui.
const verdictDe = (sortie) => ({
  acked: sortie.acked,
  refus: sortie.refus ?? null,
  raison: sortie.raison ?? null,
  destinataire: sortie.destinataire ?? null,
  signataire: sortie.signataire ?? null,
  declare: sortie.declare ?? null
});

test("A3 — l'accusé de la CLI et celui de l'outil MCP rendent le même verdict, raison comprise, sur le même décor", async () => {
  const chaise = instanceId("alice-pb", SESSION_PA);
  const CAS = [
    // [nom, appelant, lettre, self déclaré, accusé attendu, garde attendue]
    ["le destinataire accuse sa lettre", "alice-pa", "PA-nu", null, true, null],
    ["la lettre d'autrui est refusée par la garde PAR LETTRE", "bob-pa", "PA-nu", null, false, "accuse-refuse-lettre"],
    ["un self déclaré hors de la famille est refusé par la garde d'IDENTITÉ", "bob-pa", "PA-nu", "alice-pa", false, "accuse-refuse"],
    ["un nom NU ne signe pas la lettre d'une chaise vivante de sa lignée", "alice-pb", "PA-chaise", null, false, "accuse-refuse-lettre"],
    ["la chaise signe sa propre lettre", chaise, "PA-chaise", null, true, null]
  ];
  for (const [nom, appelant, lettre, declare, acked, garde] of CAS) {
    const parLaCLI = accuserParLaCLIEnParite(decorAccuse().root, appelant, lettre, declare);
    const parLeMCP = await accuserParLeMCP(decorAccuse().root, appelant, lettre, declare);
    for (const [surface, sortie] of [["CLI", parLaCLI], ["MCP", parLeMCP]]) {
      assert.equal(sortie.acked, acked, `${nom} — ${surface} : accusé ou non`);
      assert.equal(sortie.refus ?? null, garde, `${nom} — ${surface} : la garde qui a mordu`);
    }
    assert.deepEqual(verdictDe(parLaCLI), verdictDe(parLeMCP), `${nom} — le même verdict, raison comprise`);
  }
});
