// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE REJEU IDEMPOTENT DIT VRAI (remède vague D, R2 — la preuve de la revue adverse #2).
// `insertMessage` rend la ligne EXISTANTE sur conflit de `msg_id` — mais le
// guichet calculait réveil, attente et `recipient` depuis le NOUVEAU `to`
// reçu à l'appel : renvoyer un `msg_id` connu vers un autre destinataire
// répondait `recipient:"beta"` pendant que la base gardait la lettre chez
// "alpha". Tout se dérive désormais de `row` — la ligne qui a réellement été
// écrite — et un rejeu vers un autre nom le DIT (`rejeu`), plutôt que de
// prétendre en silence avoir livré où on lui a demandé.
// ⚠️ Base JETABLE (mkdtemp + CC2CC_V2_HOME) : le bureau vivant n'ouvre jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "../src/lib/database.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-rejeu-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-rejeu-"));
}

function lireJson(res) {
  return JSON.parse(res.content[0].text);
}

test("le rejeu d'un msg_id connu vers un autre destinataire dit vrai (MCP)", async (t) => {
  const root = maisonJetable();
  const client = new Client({ name: "rejeu-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur" }
  });
  t.after(async () => { try { await client.close(); } catch { /* guichet déjà fermé */ } });
  await client.connect(transport);

  // alpha et beta : deux pairs simples, une chaise chacun — pas d'ambiguïté
  // à démêler, le fait qu'on prouve ici est ailleurs.
  await client.callTool({ name: "register", arguments: { id: "alpha" } });
  await client.callTool({ name: "register", arguments: { id: "beta" } });

  const premier = lireJson(await client.callTool({
    name: "send",
    arguments: { to: "alpha", body: "premier envoi", msg_id: "idem-1" }
  }));
  assert.equal(premier.sent, true);
  assert.equal(premier.recipient, "alpha");
  assert.equal(premier.rejeu, undefined, "un envoi neuf ne porte pas de rejeu — le silence des cas sains");

  const second = lireJson(await client.callTool({
    name: "send",
    arguments: { to: "beta", body: "second envoi, même msg_id", msg_id: "idem-1" }
  }));
  assert.equal(second.sent, true);
  assert.equal(second.recipient, "alpha", "la ligne EXISTANTE gagne — jamais le nouveau `to`");
  assert.equal(second.rejeu.motif, "msg_id-deja-connu");
  assert.equal(second.rejeu.demande, "beta");

  // La base, relue en LECTURE SEULE : une seule lettre, chez le PREMIER destinataire.
  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => { try { lecture.close(); } catch { /* base jetable */ } });
  const lignes = lecture.prepare("SELECT recipient FROM messages WHERE msg_id = ?").all("idem-1");
  assert.equal(lignes.length, 1, "Camp B jusque dans le rejeu : jamais deux lettres pour un même msg_id");
  assert.equal(lignes[0].recipient, "alpha");
});

// S5 (remède de la revue adverse #2) — LE MÊME REJEU, PAR LE CLI.
// `valxos-send.js` portait déjà le commentaire « Même doctrine que le guichet MCP : un rejeu (même msg_id)
// rend la ligne EXISTANTE » — mais ne passait JAMAIS `args.msg_id` à
// `insertMessage` : la doctrine était écrite, jamais câblée. Deux envois CLI
// avec le même `--msg-id` créaient deux lignes distinctes, la branche entière
// était morte.
test("le rejeu d'un msg_id connu dit vrai aussi par le CLI", (t) => {
  const root = maisonJetable();
  const env = { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-cli" };
  const envoyer = (a) => JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-send.js"), ...a], { encoding: "utf8", env })
  );

  const premier = envoyer(["--to", "alpha", "--body", "premier envoi", "--msg-id", "idem-cli-1"]);
  assert.equal(premier.sent, true);
  assert.equal(premier.to, "alpha");
  assert.equal(premier.rejeu, undefined, "un envoi neuf ne porte pas de rejeu — le silence des cas sains");

  const second = envoyer(["--to", "beta", "--body", "second envoi, même msg_id", "--msg-id", "idem-cli-1"]);
  assert.equal(second.sent, true);
  assert.equal(second.to, "alpha", "la ligne EXISTANTE gagne — jamais le nouveau --to");
  assert.equal(second.rejeu.motif, "msg_id-deja-connu");
  assert.equal(second.rejeu.demande, "beta");

  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  t.after(() => { try { lecture.close(); } catch { /* base jetable */ } });
  const lignes = lecture.prepare("SELECT recipient FROM messages WHERE msg_id = ?").all("idem-cli-1");
  assert.equal(lignes.length, 1, "Camp B jusque dans le rejeu : jamais deux lettres pour un même msg_id, CLI compris");
  assert.equal(lignes[0].recipient, "alpha");
});
