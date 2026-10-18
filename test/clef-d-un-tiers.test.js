// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// F12 (doute de la passe adverse du Run 6, 28/09) — LA CLEF D'UN TIERS NE REND
// PAS LA LETTRE D'UN TIERS, À AUCUNE PORTE.
//
// La porte web écarte déjà un `msg_id` pris par le courrier de deux tiers
// (`deposerPourLOperateur`, garde n°2 du 22/08). L'adversaire n'avait pas
// vérifié le guichet MCP ni `valxos-send` : ils rendaient la ligne existante —
// le destinataire et le seq de la lettre d'autrui, un réveil chez lui, et le
// texte qu'on venait de taper nulle part. Même règle partout désormais : la
// clef est écartée (`clef_ecartee`), la lettre part sous une clef neuve.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-clef-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { insertMessage, openDatabase, registerPeer } = await import("../src/lib/database.js");
const { deposerAncienNom, instanceId, registerInstance } = await import("../src/lib/registry.js");
const repo = path.resolve(new URL("..", import.meta.url).pathname);

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-clef-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const tiers = insertMessage(db, { msg_id: "CLEF-DE-CAROL", sender: "carol", recipient: "dave", body: "entre carol et dave" });
  db.close();
  return { root, tiers, ouvrir: () => openDatabase({ file: path.join(root, "broker.db") }) };
}

function verifier(s, reponse, corps) {
  assert.equal(reponse.sent, true);
  assert.notEqual(reponse.msg_id, "CLEF-DE-CAROL", "la lettre part sous une clef neuve");
  assert.notEqual(reponse.seq, s.tiers.seq, "jamais le seq de la lettre d'autrui");
  assert.equal(reponse.recipient ?? reponse.to, "bob", "jamais le destinataire d'autrui (MCP : recipient, CLI : to)");
  assert.equal(reponse.rejeu, undefined, "ce n'est pas un rejeu : la clef n'était pas la sienne");
  assert.deepEqual(reponse.clef_ecartee, { demandee: "CLEF-DE-CAROL", motif: "clef-deja-prise" });
  const v = s.ouvrir();
  const partie = v.prepare("SELECT sender, recipient, body FROM messages WHERE msg_id = ?").get(reponse.msg_id);
  const intacte = v.prepare("SELECT sender, recipient, body FROM messages WHERE msg_id = 'CLEF-DE-CAROL'").get();
  v.close();
  assert.deepEqual(partie, { sender: "alice", recipient: "bob", body: corps }, "le texte tapé est parti");
  assert.deepEqual(intacte, { sender: "carol", recipient: "dave", body: "entre carol et dave" });
}

test("F12 — MCP send avec le msg_id d'une lettre de tiers : clef écartée, lettre partie, rien d'autrui rendu", async () => {
  const s = scene();
  const c = new Client({ name: "valxos-clef", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: [path.join(repo, "src/mcp-server/server.js")], env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "alice" })
  }));
  try {
    const r = JSON.parse((await c.callTool({ name: "send", arguments: { to: "bob", body: "par le MCP", msg_id: "CLEF-DE-CAROL" } })).content[0].text);
    verifier(s, r, "par le MCP");
    // Le renvoi honnête, lui, reste idempotent : la clef est maintenant à alice.
    const encore = JSON.parse((await c.callTool({ name: "send", arguments: { to: "bob", body: "par le MCP", msg_id: r.msg_id } })).content[0].text);
    assert.equal(encore.msg_id, r.msg_id);
    assert.equal(encore.seq, r.seq);
    assert.equal(encore.clef_ecartee, undefined);
  } finally {
    await c.close();
  }
});

test("F12 — valxos-send avec le msg_id d'une lettre de tiers : même règle", () => {
  const s = scene();
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-send.js"), "--to", "bob", "--body", "par le CLI", "--msg-id", "CLEF-DE-CAROL"], {
    encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "alice" })
  });
  assert.equal(r.status, 0, r.stderr);
  verifier(s, JSON.parse(r.stdout), "par le CLI");
});

// FIX ROUND 2 (re-revue r1, M-1 → Important) — L'EXPÉDITEUR SE VÉRIFIE. Un
// `from: "dave"` (MCP) ou `--self carol` (CLI) faisait passer la clef d'une
// lettre carol→dave pour la sienne : la ligne d'autrui revenait, et dave était
// réveillé. La propriété de la clef se juge sur l'identité DÉRIVÉE ; un
// expéditeur déclaré passe `verifierIdentiteDeclaree`, sinon refus.
function compter(s) {
  const v = s.ouvrir();
  const n = v.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  v.close();
  return n;
}

test("fix 2 — MCP send sous un `from` d'autrui : refusé, aucune ligne d'autrui rendue, rien posé", async () => {
  const s = scene();
  const c = new Client({ name: "valxos-clef", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: [path.join(repo, "src/mcp-server/server.js")], env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "alice" })
  }));
  try {
    const r = JSON.parse((await c.callTool({ name: "send", arguments: { to: "bob", from: "dave", body: "x", msg_id: "CLEF-DE-CAROL" } })).content[0].text);
    assert.equal(r.sent, false, JSON.stringify(r));
    assert.equal(r.refus, "expediteur-refuse");
    assert.equal(r.seq, undefined, "jamais le seq d'autrui");
    assert.equal(r.recipient, undefined, "jamais le destinataire d'autrui");
    const b = JSON.parse((await c.callTool({ name: "broadcast", arguments: { from: "dave", body: "x" } })).content[0].text);
    assert.equal(b.refus, "expediteur-refuse", "la diffusion vérifie aussi son expéditeur");
  } finally {
    await c.close();
  }
  assert.equal(compter(s), 1, "rien n'a été posé");
});

test("fix 2 — valxos-send --self d'autrui : refusé (sortie 1), aucune ligne d'autrui rendue, rien posé", () => {
  const s = scene();
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-send.js"), "--self", "carol", "--to", "bob", "--body", "x", "--msg-id", "CLEF-DE-CAROL"], {
    encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "alice" })
  });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  const sortie = JSON.parse(r.stdout);
  assert.equal(sortie.refus, "expediteur-refuse");
  assert.equal(sortie.to, undefined);
  assert.equal(sortie.seq, undefined);
  assert.equal(compter(s), 1, "rien n'a été posé");
});

test("fix 2 — un expéditeur déclaré égal au dérivé passe toujours (MCP from et CLI --self)", async () => {
  const s = scene();
  const r = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-send.js"), "--self", "alice", "--to", "bob", "--body", "par le CLI"], {
    encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: "alice" })
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).from, "alice");
});

// J4 (jury, 18/10) — UN NOM DÉCLARÉ ACCEPTÉ POSTE SOUS LE NOM DÉRIVÉ.
//
// `valxos-send --from <ancien nom qui mène à l'appelant>` (ou `--self`) passait la
// vérification d'identité, puis POSTAIT SOUS LE NOM DÉCLARÉ. La règle de la clef
// (`posterSousUneClefASoi`, guichet.js) juge « à moi » une ligne dont l'expéditeur ou
// le destinataire est le nom DÉRIVÉ : la ligne qu'on venait de poser portait l'ancien
// nom, elle n'était pas « à moi », le guichet reposait sous une clef neuve — et levait.
// Résultat mesuré sur un bureau jetable : DEUX lettres d'expéditeur « ancien nom »,
// sortie 1 avec une pile, et une fiche de pair créée pour l'ancien nom.
//
// La CLI n'a pas de chaise : tout nom déclaré ACCEPTÉ est une demande vérifiée, jamais
// une identité — la lettre part sous le nom DÉRIVÉ. Un nom refusé reste refusé.
function bureauAvecAncienNom({ chaise = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-j4-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  let appelant;
  if (chaise) {
    registerInstance(db, { lineage: "alice-j4", sessionId: "sess-j4", pid: process.pid });
    appelant = instanceId("alice-j4", "sess-j4");
  } else {
    registerPeer(db, { id: "alice-j4", status: "active" });
    appelant = "alice-j4";
  }
  deposerAncienNom(db, "alice-j4-ancien", "alice-j4");
  db.close();
  return { root, appelant, ouvrir: () => openDatabase({ file: path.join(root, "broker.db"), readonly: true }) };
}

function envoyerSous(s, drapeaux) {
  return spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-send.js"), ...drapeaux, "--to", "bob", "--body", "par un ancien nom", "--msg-id", "J4-cle"], {
    encoding: "utf8", env: envPropre({ CC2CC_V2_HOME: s.root, CC2CC_SELF: s.appelant })
  });
}

for (const [drapeau, chaise] of [["--from", false], ["--self", false], ["--from", true], ["--self", true]]) {
  test(`J4 — valxos-send ${drapeau} <ancien nom de l'appelant${chaise ? ", une chaise" : ""}> : UNE lettre, sous le nom dérivé, aucune fiche pour l'ancien nom`, () => {
    const s = bureauAvecAncienNom({ chaise });
    const r = envoyerSous(s, [drapeau, "alice-j4-ancien"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const sortie = JSON.parse(r.stdout);
    assert.equal(sortie.sent, true);
    assert.equal(sortie.from, s.appelant, "l'expéditeur annoncé est le nom dérivé");

    const lecture = s.ouvrir();
    try {
      const lignes = lecture.prepare("SELECT msg_id, sender, recipient, body FROM messages ORDER BY seq").all();
      assert.deepEqual(
        lignes,
        [{ msg_id: "J4-cle", sender: s.appelant, recipient: "bob", body: "par un ancien nom" }],
        "exactement une ligne, sous le nom dérivé"
      );
      assert.equal(lecture.prepare("SELECT COUNT(*) AS n FROM peers WHERE id = 'alice-j4-ancien'").get().n, 0, "aucune fiche de pair pour l'ancien nom");
    } finally {
      lecture.close();
    }

    // Le renvoi honnête sous la même clef reste idempotent : toujours une seule ligne.
    const encore = envoyerSous(s, [drapeau, "alice-j4-ancien"]);
    assert.equal(encore.status, 0, `${encore.stdout}\n${encore.stderr}`);
    assert.equal(JSON.parse(encore.stdout).rejeu?.motif, "msg_id-deja-connu", "le renvoi s'annonce comme un rejeu");
    const relecture = s.ouvrir();
    try {
      assert.equal(relecture.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1, "toujours UNE ligne après le renvoi");
    } finally {
      relecture.close();
    }
  });
}

test("J4 — un nom déclaré REFUSÉ reste refusé, par --from comme par --self : rien n'est posé, aucune fiche n'est créée", () => {
  for (const drapeau of ["--from", "--self"]) {
    const s = bureauAvecAncienNom();
    const r = envoyerSous(s, [drapeau, "carol"]);
    assert.equal(r.status, 1, `${drapeau} : ${r.stdout}\n${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).refus, "expediteur-refuse");
    const lecture = s.ouvrir();
    try {
      assert.equal(lecture.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0, `${drapeau} : rien n'a été posé`);
      assert.equal(lecture.prepare("SELECT COUNT(*) AS n FROM peers WHERE id = 'carol'").get().n, 0, `${drapeau} : aucune fiche pour le nom refusé`);
    } finally {
      lecture.close();
    }
  }
});
