// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE FAIT DU REJEU VIENT DE LÀ OÙ IL EST CONNU (ronde 2, 22/08).
//
// ⚠️ POURQUOI CE FICHIER EXISTE. Le remède ④ a déplacé l'annonce du rejeu dans
// le guichet — bonne idée, demi-geste : il a déplacé l'ANNONCE sans déplacer la
// SOURCE du fait. Le guichet ne recevait pas « ceci est un rejeu », il le
// DÉDUISAIT d'une comparaison (`row.recipient !== entree.recipient`). Une
// déduction se trompe de deux façons, et elle se trompait des deux :
//
//   ⑦ FAUX POSITIF — `insertMessage` accepte DEUX orthographes du destinataire
//     (`input.recipient || input.to`, database.js) et la docstring du guichet
//     promet « `entree` est ce qu'`insertMessage` attend ». Un appelant qui
//     passe `{ to, body, sender }` — la forme EXACTE du schéma d'entrée de
//     l'outil MCP `send`, donc le raccourci évident pour la porte web — donnait
//     `entree.recipient === undefined`, la comparaison était vraie, et le
//     guichet annonçait un rejeu sur une lettre NEUVE dans une base VIDE.
//     Avant ④ le défaut était impossible : chaque surface comparait au `to`
//     qu'ELLE avait reçu, toujours la bonne valeur par construction. Régression.
//
//   ⑧ FAUX NÉGATIF — la comparaison porte sur la divergence du DESTINATAIRE,
//     jamais sur le fait du rejeu. Deux envois du même msg_id vers le même nom
//     avec deux corps différents : le second rendait `sent:true` sec, sans un
//     mot, et le corps que le posteur venait de taper était jeté. C'est A8 qui
//     ment — le pire silence possible de ce produit.
//
// Le remède ne déplace pas une comparaison de plus : il fait REMONTER les deux
// faits depuis `inscrireUneLettre`, seul endroit où ils sont connus sans être
// devinés (elle normalise le destinataire demandé, et `row.changes` lui dit si
// la ligne est neuve ou retrouvée).
//
// ⚠️ Base JETABLE (mkdtemp + CC2CC_V2_HOME) : le bureau vivant (~/.cc2cc-v2)
// n'est JAMAIS ouvert ici (remède de la revue adverse F2). Le plancher se pose
// AVANT le premier import qui touche `baseDir()`.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-fait-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { openDatabase } from "../src/lib/database.js";
import { posterUneLettre } from "../src/lib/guichet.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

const decors = [];
function maisonJetable(prefixe = "cc2cc-fait-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureauDePoste(t) {
  const root = maisonJetable("cc2cc-fait-home-");
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

// Le réveil ne frappe à AUCUNE vraie porte : ce fichier ne juge que ce que le
// guichet DIT au posteur, jamais l'état d'une socket.
function reveilMuet() {
  return async (agentId) => ({ ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" });
}
const MAISONS_VIDES = () => ({ houses: [], parSession: new Map() });

function envoyerParLeCLI(root, args) {
  return JSON.parse(
    execFileSync("node", [path.join(repo, "src/bin/valxos-send.js"), ...args], {
      encoding: "utf8",
      env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-fait" }
    })
  );
}

// ── ⑦ : LA LETTRE NEUVE N'EST LE REJEU DE RIEN, QUELLE QUE SOIT L'ORTHOGRAPHE ─
test("⑦ un appelant qui écrit `to` (l'orthographe de l'outil MCP) n'obtient AUCUN rejeu sur une base vide", async (t) => {
  const db = bureauDePoste(t);

  // Le décor est nu : aucune lettre, aucun msg_id n'a jamais existé ici.
  const avant = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  assert.equal(avant, 0, "le décor ne vaut QUE si la base est vraiment vide");

  // La forme EXACTE du schéma d'entrée de `send` (server.js) — celle que la
  // porte web reprendra telle quelle, et que la docstring du guichet autorise.
  const poste = await posterUneLettre(
    db,
    { to: "alpha", body: "toute première lettre", sender: "expediteur" },
    { reveiller: reveilMuet(), maisons: MAISONS_VIDES() }
  );

  assert.equal(poste.row.recipient, "alpha", "`to` est une orthographe légitime : la lettre part bien chez alpha");
  assert.equal(poste.row.body, "toute première lettre");
  assert.equal(
    poste.rejeu,
    null,
    "AUCUN rejeu : rien n'a été rejoué, la base était vide — l'annoncer serait un mensonge pur"
  );
  assert.ok(!poste.ecarte, "et rien n'a été écarté : tout ce que le posteur a tapé est parti");
});

// LE VERROU DE LA NORMALISATION UNIQUE (contrainte 2 du remède).
// Le test ⑦ ci-dessus ne suffit PAS à interdire une recopie de
// `input.recipient || input.to` dans le guichet : sur une lettre neuve, le
// rejeu est nul de toute façon, et une deuxième copie de la normalisation y
// resterait invisible. Il faut un REJEU écrit à l'orthographe `to` — là, une
// copie divergente se voit tout de suite, elle rend `demande: undefined`.
// Mutation exécutée sur le remède : `const demande = entree?.recipient` remis
// dans le guichet → ce test-ci ROUGE (undefined ≠ "beta"), et lui seul.
test("⑦ le `demande` annoncé sur un rejeu écrit `to` porte le NOM demandé, jamais `undefined`", async (t) => {
  const db = bureauDePoste(t);

  await posterUneLettre(
    db,
    { msg_id: "mm-to", to: "alpha", body: "premiere", sender: "expediteur" },
    { reveiller: reveilMuet(), maisons: MAISONS_VIDES() }
  );
  const second = await posterUneLettre(
    db,
    { msg_id: "mm-to", to: "beta", body: "premiere", sender: "expediteur" },
    { reveiller: reveilMuet(), maisons: MAISONS_VIDES() }
  );

  assert.equal(second.row.recipient, "alpha", "la ligne EXISTANTE parle");
  assert.deepEqual(
    second.rejeu,
    { motif: "msg_id-deja-connu", demande: "beta" },
    "le destinataire demandé se normalise à UN seul endroit — la base. Une copie dans le guichet dirait `undefined`"
  );
});

// CONTRÔLE POSITIF, vert AVANT comme APRÈS le remède (dit ici plutôt que
// maquillé en rouge) : `send` passe `recipient: to` et n'a donc jamais souffert
// de ⑦. Il reste pour que la surface principale ne bascule pas un jour sur le
// raccourci `{to}` en croyant que c'est équivalent.
test("⑦ (par la vraie surface) : le MCP `send` sur une base vide ne porte pas de rejeu", async (t) => {
  const root = maisonJetable();
  const client = new Client({ name: "cc2cc-fait-mcp", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-fait" }
  });
  t.after(async () => {
    try {
      await client.close();
    } catch {
      /* guichet déjà fermé */
    }
  });
  await client.connect(transport);

  const reponse = JSON.parse(
    (await client.callTool({ name: "send", arguments: { to: "alpha", body: "toute première lettre" } }))
      .content[0].text
  );
  assert.equal(reponse.sent, true);
  assert.equal(reponse.recipient, "alpha");
  assert.equal(reponse.rejeu, undefined, "un envoi neuf ne porte pas de rejeu — le silence des cas sains");
});

// ── ⑧ : LE FAIT DU REJEU, PAS LA DIVERGENCE DU DESTINATAIRE ─────────────────
test("⑧ même msg_id, MÊME destinataire, autre corps : le posteur apprend que son texte a été jeté", async (t) => {
  const db = bureauDePoste(t);

  await posterUneLettre(
    db,
    { msg_id: "mm", recipient: "alpha", body: "premiere", sender: "expediteur" },
    { reveiller: reveilMuet(), maisons: MAISONS_VIDES() }
  );

  const second = await posterUneLettre(
    db,
    { msg_id: "mm", recipient: "alpha", body: "SECONDE, perdue", sender: "expediteur" },
    { reveiller: reveilMuet(), maisons: MAISONS_VIDES() }
  );

  assert.equal(second.row.body, "premiere", "Camp B : la première lettre reste, aucune seconde ne naît");
  assert.deepEqual(
    second.rejeu,
    { motif: "msg_id-deja-connu", demande: "alpha" },
    "le rejeu s'annonce sur LE FAIT du rejeu — le destinataire n'a pas besoin de diverger pour ça"
  );
  assert.deepEqual(
    second.ecarte,
    { body: "SECONDE, perdue" },
    "et ce que le posteur vient de taper et qui n'est parti nulle part lui est RENDU, pas jeté en silence"
  );
});

test("⑧ un rejeu strictement IDENTIQUE ne crie pas au loup : rejeu annoncé, rien d'écarté", async (t) => {
  const db = bureauDePoste(t);

  const entree = { msg_id: "idem", recipient: "alpha", body: "la même", sender: "expediteur" };
  await posterUneLettre(db, { ...entree }, { reveiller: reveilMuet(), maisons: MAISONS_VIDES() });
  const second = await posterUneLettre(db, { ...entree }, { reveiller: reveilMuet(), maisons: MAISONS_VIDES() });

  assert.deepEqual(second.rejeu, { motif: "msg_id-deja-connu", demande: "alpha" }, "le fait du rejeu reste dit");
  assert.equal(
    second.ecarte,
    null,
    "mais RIEN n'a été perdu : un renvoi idempotent honnête ne doit pas être maquillé en perte de données"
  );
});

test("⑧ (par le binaire PUBLIÉ) : le second `--msg-id` identique ne rend plus un `sent:true` sec", () => {
  const root = maisonJetable();

  const premier = envoyerParLeCLI(root, ["--to", "alpha", "--msg-id", "mm", "--body", "premiere"]);
  assert.equal(premier.sent, true);
  assert.equal(premier.rejeu, undefined, "un envoi neuf ne porte pas de rejeu");
  assert.equal(premier.ecarte, undefined, "et n'écarte rien");

  const second = envoyerParLeCLI(root, ["--to", "alpha", "--msg-id", "mm", "--body", "SECONDE, perdue"]);
  assert.equal(second.sent, true, "l'annonce ne casse JAMAIS la prise en charge (A9)");
  assert.equal(second.to, "alpha");
  assert.equal(second.rejeu?.motif, "msg_id-deja-connu", "le rejeu se dit, même sans divergence de destinataire");
  assert.deepEqual(
    second.ecarte,
    { body: "SECONDE, perdue" },
    "le corps jeté revient au posteur par la sortie du binaire — sinon il est perdu pour de bon"
  );

  // La base, relue en LECTURE SEULE : une seule lettre, le PREMIER corps.
  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  try {
    const lignes = lecture.prepare("SELECT body FROM messages WHERE msg_id = ?").all("mm");
    assert.equal(lignes.length, 1, "Camp B : jamais deux lettres pour un même msg_id");
    assert.equal(lignes[0].body, "premiere", "c'est bien le PREMIER corps qui reste — le second est vraiment jeté");
  } finally {
    lecture.close();
  }
});

test("⑧ (par le MCP) : la surface principale annonce elle aussi le corps jeté", async (t) => {
  const root = maisonJetable();
  const client = new Client({ name: "cc2cc-fait-mcp-8", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-fait" }
  });
  t.after(async () => {
    try {
      await client.close();
    } catch {
      /* guichet déjà fermé */
    }
  });
  await client.connect(transport);

  const envoyer = async (body) =>
    JSON.parse(
      (await client.callTool({ name: "send", arguments: { to: "alpha", body, msg_id: "mm-mcp" } })).content[0].text
    );

  await envoyer("premiere");
  const second = await envoyer("SECONDE, perdue");

  assert.equal(second.sent, true);
  assert.equal(second.recipient, "alpha");
  assert.equal(second.rejeu?.motif, "msg_id-deja-connu");
  assert.deepEqual(
    second.ecarte,
    { body: "SECONDE, perdue" },
    "A8 vaut pour TOUTES les surfaces : un posteur MCP dont le texte est jeté doit l'apprendre aussi"
  );
});

// ── ⑨ : `from` SE DÉRIVE DE LA LIGNE, EXACTEMENT COMME `to` ─────────────────
// Le dernier demi-geste de R2 : la réponse du binaire mélangeait deux sources —
// `to: row.recipient` (la base) et `from: sender` (la variable de CET appel-ci).
// Sur un rejeu elle attribuait donc la lettre à quelqu'un qui ne l'a pas écrite.
test("⑨ le `from` annoncé par le CLI vient de la LIGNE, jamais de l'expéditeur de cet appel-ci", () => {
  const root = maisonJetable();
  const envoyerAvecSelf = (self, args) =>
    JSON.parse(
      execFileSync("node", [path.join(repo, "src/bin/valxos-send.js"), ...args], {
        encoding: "utf8",
        env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: self }
      })
    );

  // F12 (28/09) : une clef rejouée ne rend la ligne existante que si elle
  // appartient au courrier du posteur (envoyé OU reçu sous son nom) — la clef
  // d'une lettre entre deux tiers est écartée (test/clef-d-un-tiers.test.js).
  // Le cas où `from` peut diverger de l'appel est donc celui-ci : exp-deux
  // rejoue la clef d'une lettre qu'il a REÇUE d'exp-un.
  const premier = envoyerAvecSelf("exp-un", ["--to", "exp-deux", "--body", "premiere", "--msg-id", "r1", "--self", "exp-un"]);
  assert.equal(premier.from, "exp-un", "l'envoi neuf est bien signé de son auteur");

  const second = envoyerAvecSelf("exp-deux", ["--to", "alpha", "--body", "premiere", "--msg-id", "r1", "--self", "exp-deux"]);
  assert.equal(second.msg_id, "r1", "la clef est au courrier d'exp-deux (il l'a reçue) : c'est un rejeu");
  assert.equal(
    second.from,
    "exp-un",
    "la lettre EN BASE est d'exp-un : l'attribuer à exp-deux réécrirait sa signature dans la réponse"
  );

  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  try {
    assert.equal(
      lecture.prepare("SELECT sender FROM messages WHERE msg_id = ?").get("r1").sender,
      "exp-un",
      "l'oracle absolu : la base dit exp-un"
    );
  } finally {
    lecture.close();
  }
});
