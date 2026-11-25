// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LES LETTRES CALMES ET LES COPIES (1.1.0, Tâche 4).
//
// Une lettre `sans_copie` (toute lettre d'une table fermée) n'est jamais une copie cc ; une lettre
// `sans_reveil` (table ou membre en `prochain-tour`, réaction en mode direct) n'est ni portée par le
// Facteur ni bloquante au Stop — mais elle est SERVIE par le canal de repli : rien n'est perdu (A9).
//
// ⚠️ Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant n'est
// JAMAIS ouvert ici. Le plancher se pose AVANT le premier test (`openDatabase` lit `baseDir()`, donc
// l'ENV du runner — remède de la revue adverse F2). Chaque hook enfant reçoit aussi une maison
// jetable et vide (`CLAUDE_CONFIG_DIR`) : il ne lit la fiche d'aucune maison réelle.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { getCopiesPourChaise, getPendingForContext, insertMessage, openDatabase } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { copiesPourChaise } from "../src/lib/identity.js";
import { ajouterMembre, creerTable, modifierTable } from "../src/lib/tables.js";
import { posterAUneTable } from "../src/lib/guichet.js";
import { faireLaTournee } from "../src/facteur/round.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-calme-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

const decors = [];
function decorJetable(prefixe = "cc2cc-calme-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  decors.push(dir);
  return dir;
}
after(() => {
  for (const dir of decors) fs.rmSync(dir, { recursive: true, force: true });
});

function bureauDePoste(t) {
  const root = decorJetable("cc2cc-calme-home-");
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  db.racine = root;
  t.after(() => {
    try {
      db.close();
    } catch {
      /* base jetable */
    }
  });
  return db;
}

// Une chaise vivante : une instance au registre + la boîte que l'inventaire rend (test/facteur.test.js).
function chaise(db, { lignee, session, maison = "/maison/carton", pid = 4242, socketPath = "/carton.sock", token = null }) {
  registerInstance(db, { lineage: lignee, sessionId: session, house: maison, pid });
  return {
    house: maison,
    pid,
    sessionId: session,
    name: lignee,
    socketPath,
    kind: null,
    status: "idle",
    procStart: "Thu Aug 13 09:00:00 2026",
    preuve: "registre",
    token
  };
}

// L'inventaire que rend la tournée des maisons : les boîtes ET les maisons parcourues.
function inventaire(boites, maisons = null) {
  const noms = maisons || [...new Set(boites.map((b) => b.house))];
  const houses = noms.map((house) => ({
    house,
    readable: true,
    fiches: 1,
    boxes: 1,
    sondees: 0,
    endormies: 0,
    illisibles: 0,
    doublons: 0
  }));
  return () => ({ boxes: boites, houses });
}

// Un guichet de carton : il note ce qu'on lui tend et rend le verdict demandé.
function guichetDeCarton(verdict = { ok: true, etat: "remis-au-guichet" }) {
  const remises = [];
  const remettre = async (arg) => {
    remises.push(arg);
    return verdict;
  };
  return { remises, remettre };
}

// Les dépendances communes : aucune maison réelle, aucune vraie pause.
function depsDeBase(extra = {}) {
  return { maisons: [], dormir: async () => {}, ...extra };
}

// Le guichet des tables ne frappe à aucune vraie porte et ne scanne aucune maison.
const MAISONS_VIDES = { houses: [], parSession: new Map() };
const reveilDeCarton = async (agentId) => ({ ok: false, socketPath: `/carton/${agentId}.sock`, error: "ENOENT" });

// Un hook dans son propre processus, sur le bureau jetable (test/hooks.test.js), avec une maison
// jetable et vide : aucune fiche réelle n'est lue.
function runHook(script, root, input = {}, self = "alice") {
  const maison = path.join(root, "maison-jetable");
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  return spawnSync("node", [path.join(repo, "src/hooks", script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: self, CLAUDE_CONFIG_DIR: maison }
  });
}

// Un serveur MCP lancé par CE runner : son parent n'est pas une session, et sa maison est vide —
// c'est un client SANS chaise (lignée nue), comme Codex ou Gemini CLI (test/jumeau-porte-mcp.test.js).
async function clientNu(root, self) {
  const client = new Client({ name: `valxos-calme-test-${self}`, version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_GARDE_BUREAU: "1", CC2CC_SELF: self, CLAUDE_CONFIG_DIR: path.join(root, "maison-absente") }
  });
  await client.connect(transport);
  return client;
}
const outil = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return r.isError ? { erreur: r.content[0].text } : JSON.parse(r.content[0].text);
};

// ── LES COPIES ─────────────────────────────────────────────────────────────────────────────────
test("une lettre sans_copie n'apparaît jamais dans getCopiesPourChaise ; sans le drapeau, elle y est", (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L-fermee", sender: "bob", recipient: "alice", body: "closed-table letter", sans_copie: 1 });
  insertMessage(db, { msg_id: "L-ouverte", sender: "bob", recipient: "alice", body: "open-table letter", sans_copie: 0 });
  // Trois issues, jamais deux : si le guichet (Tâche 2) n'écrit pas la colonne, la sonde le dit.
  assert.equal(
    db.prepare("SELECT sans_copie FROM messages WHERE msg_id = 'L-fermee'").get().sans_copie,
    1,
    "SONDE IMPOSSIBLE : insertMessage n'écrit pas sans_copie (Tâche 2)"
  );
  assert.deepEqual(
    getCopiesPourChaise(db, "alice", "alice#s1").map((r) => r.msg_id),
    ["L-ouverte"],
    "la lettre de la table fermée n'est pas une copie ; celle de la table ouverte l'est"
  );
});

// POINT DE REVUE 2. Un membre donné par sa lignée (`alice`), deux chaises vivantes et aucune
// désignée : le guichet dit « ambigu », la lettre attend. Pour une table OUVERTE chaque chaise
// verrait une copie « sans-chaise-designee » ; pour une table FERMÉE, personne ne la voit en
// attendant. Le contrôle sur la table ouverte prouve que l'instrument voit bien les copies quand
// elles sont permises : le silence du dessus n'est pas un trou de la sonde.
test("point de revue 2 — table fermée + lignée ambiguë : la lettre attend avec sans_copie = 1 et aucune chaise n'en voit une copie", async (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "alice", sessionId: "s1", house: "/maison/carton", pid: 4242 });
  registerInstance(db, { lineage: "alice", sessionId: "s2", house: "/maison/carton", pid: 4243 });
  creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
  ajouterMembre(db, "office-test", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "office-test", "bob", { ajoutePar: "office-test" });
  creerTable(db, { nom: "famille-test", creeePar: "office-test" });
  ajouterMembre(db, "famille-test", "alice", { ajoutePar: "office-test" });
  ajouterMembre(db, "famille-test", "bob", { ajoutePar: "office-test" });
  const deps = { maisons: MAISONS_VIDES, reveiller: reveilDeCarton };

  const fermee = await posterAUneTable(db, { sender: "bob", table: "office-test", body: "for the closed table" }, deps);
  assert.equal(fermee.count, 1, "un seul membre hors de l'expéditeur");
  const lettre = fermee.lettres[0];
  assert.equal(lettre.to, "alice");
  assert.equal(lettre.row.sans_copie, 1, "une lettre de table fermée ne donne jamais de copie");
  assert.equal(lettre.attente?.motif, "lignee-ambigue", "deux chaises, aucune désignée : la lettre attend");
  for (const session of ["s1", "s2"]) {
    const cc = copiesPourChaise(db, "alice", session);
    assert.equal(cc.sansChaiseDesignee, true, `la chaise ${session} serait en régime de copie « tenue »…`);
    assert.deepEqual(cc.rows, [], `…et pourtant elle ne voit RIEN de la table fermée (${session})`);
  }

  // Le contrôle : la même lettre à une table OUVERTE est une copie pour chacune des deux chaises.
  const ouverte = await posterAUneTable(db, { sender: "bob", table: "famille-test", body: "for the open table" }, deps);
  assert.equal(ouverte.lettres[0].row.sans_copie, 0);
  for (const session of ["s1", "s2"]) {
    assert.deepEqual(
      copiesPourChaise(db, "alice", session).rows.map((r) => r.msg_id),
      [ouverte.lettres[0].row.msg_id],
      `la table ouverte, elle, se voit en copie depuis ${session}`
    );
  }
});

// POINT DE REVUE 2, DE BOUT EN BOUT : les hooks des deux chaises. Ni PostToolUse ni SessionStart
// ne montrent la lettre de la table fermée (ni livrée, ni en copie, ni marquée vue) ; le contrôle
// sur la table ouverte montre le bloc CC dans les mêmes hooks — l'instrument voit ce qu'il doit voir.
test("point de revue 2, hooks — aucune des deux chaises ne voit la lettre d'une table fermée qui attend ; la table ouverte, si", async (t) => {
  const db = bureauDePoste(t);
  const root = db.racine;
  registerInstance(db, { lineage: "alice", sessionId: "s1", house: "/maison/carton", pid: 4242 });
  registerInstance(db, { lineage: "alice", sessionId: "s2", house: "/maison/carton", pid: 4243 });
  creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
  creerTable(db, { nom: "famille-test", creeePar: "office-test" });
  for (const nom of ["office-test", "famille-test"]) {
    ajouterMembre(db, nom, "alice", { ajoutePar: "office-test" });
    ajouterMembre(db, nom, "bob", { ajoutePar: "office-test" });
  }
  const deps = { maisons: MAISONS_VIDES, reveiller: reveilDeCarton };
  const fermee = await posterAUneTable(db, { sender: "bob", table: "office-test", body: "for the closed table" }, deps);
  assert.equal(fermee.lettres[0].attente?.motif, "lignee-ambigue");
  const idFermee = fermee.lettres[0].row.msg_id;
  db.close();

  const contexteDe = (r) => {
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "";
  };
  for (const session of ["s1", "s2"]) {
    for (const [script, evenement] of [["piggyback_fetch.js", "PostToolUse"], ["startup_sync.js", "SessionStart"]]) {
      const vu = contexteDe(runHook(script, root, { hook_event_name: evenement, session_id: session }));
      assert.doesNotMatch(vu, /for the closed table/, `${evenement} de la chaise ${session} ne montre rien de la table fermée`);
    }
  }
  const db2 = openDatabase({ file: path.join(root, "broker.db") });
  assert.equal(db2.prepare("SELECT delivered_at FROM messages WHERE msg_id = ?").get(idFermee).delivered_at, null, "elle attend : livrée à personne");
  assert.equal(
    db2.prepare("SELECT count(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = 'cc_vu'").get(idFermee).n,
    0,
    "aucune chaise ne l'a vue en copie"
  );

  // Le contrôle : la lettre de la table ouverte se voit en copie depuis les deux chaises — par
  // PostToolUse pour l'une, par SessionStart pour l'autre (une copie ne se voit qu'une fois par
  // chaise). Le bloc CC est ENRICHI comme une lettre : la ligne `Table:` avec la position du jour,
  // et le nom humain de la chaise qui a posté (revue T4, mineur 4 : l'appel des deux hooks épinglé).
  registerInstance(db2, { lineage: "bob", sessionId: "s-bob", house: "/maison/carton", pid: 4244, sessionName: "atelier" });
  modifierTable(db2, "famille-test", { position: "act 2", positionPar: "bob" });
  const ouverte = await posterAUneTable(db2, { sender: "bob", sender_chaise: "bob#s-bob", table: "famille-test", body: "for the open table" }, deps);
  assert.equal(ouverte.lettres[0].row.sans_copie, 0);
  db2.close();
  for (const [session, script, evenement] of [["s1", "piggyback_fetch.js", "PostToolUse"], ["s2", "startup_sync.js", "SessionStart"]]) {
    const vu = contexteDe(runHook(script, root, { hook_event_name: evenement, session_id: session }));
    assert.match(vu, /VALXOS Messenger CC/, `la chaise ${session} voit le bloc CC de la table ouverte (${evenement})`);
    assert.match(vu, /for the open table/);
    assert.doesNotMatch(vu, /for the closed table/, "et toujours rien de la fermée");
    const lignes = vu.split("\n");
    assert.ok(lignes.includes('Table: famille-test (normal) · position: "act 2"'), `${evenement} : la copie porte sa ligne de table\n${vu}`);
    assert.ok(lignes.includes("From: bob (atelier)"), `${evenement} : la copie nomme la chaise qui a posté\n${vu}`);
  }
});

// POINT DE REVUE 2, PAR `inbox` D'UN CLIENT SANS CHAISE. Deux régimes : la lignée ambiguë (deux
// chaises, aucune désignée) et la lignée tenue par UNE chaise vivante — le régime où un client nu
// reçoit en copie le courrier de sa lignée (copiesSansChaise). Dans les deux, la lettre de la table
// fermée n'est ni dans `messages` ni dans `copies` ; le contrôle (table ouverte, chaise unique) se
// voit bien en copie : l'instrument n'est pas aveugle.
test("point de revue 2, inbox — un client sans chaise ne voit jamais la lettre d'une table fermée, ni en lettre ni en copie", async (t) => {
  for (const regime of ["ambigu", "chaise-unique"]) {
    const db = bureauDePoste(t);
    const root = db.racine;
    registerInstance(db, { lineage: "alice", sessionId: "s1", house: "/maison/carton", pid: process.pid });
    if (regime === "ambigu") registerInstance(db, { lineage: "alice", sessionId: "s2", house: "/maison/carton", pid: process.pid });
    creerTable(db, { nom: "office-test", fermee: true, creeePar: "office-test" });
    creerTable(db, { nom: "famille-test", creeePar: "office-test" });
    for (const nom of ["office-test", "famille-test"]) {
      ajouterMembre(db, nom, "alice", { ajoutePar: "office-test" });
      ajouterMembre(db, nom, "bob", { ajoutePar: "office-test" });
    }
    const deps = { maisons: MAISONS_VIDES, reveiller: reveilDeCarton };
    const fermee = await posterAUneTable(db, { sender: "bob", table: "office-test", body: "for the closed table" }, deps);
    assert.equal(fermee.lettres[0].row.sans_copie, 1);
    if (regime === "ambigu") assert.equal(fermee.lettres[0].attente?.motif, "lignee-ambigue");
    const ouverte = await posterAUneTable(db, { sender: "bob", table: "famille-test", body: "for the open table" }, deps);
    db.close();

    const c = await clientNu(root, "alice");
    try {
      const boite = await outil(c, "inbox", { mark_delivered: false });
      assert.equal(boite.erreur, undefined, boite.erreur);
      const vus = [...(boite.messages || []), ...(boite.copies || [])];
      assert.deepEqual(
        vus.filter((l) => l.body === "for the closed table"),
        [],
        `${regime} : la lettre de la table fermée n'est ni une lettre ni une copie du client nu`
      );
      if (regime === "chaise-unique") {
        assert.deepEqual(
          (boite.copies || []).map((l) => l.msg_id),
          [ouverte.lettres[0].row.msg_id],
          "le contrôle : la lettre de la table ouverte, tenue par la chaise, est bien une copie du client nu"
        );
      }
    } finally {
      await c.close();
    }
  }
});

// ── LE FACTEUR ─────────────────────────────────────────────────────────────────────────────────
// Une lettre calme n'est pas prise en tournée : ni tentative, ni enveloppe, ni `carried_at`. La
// lettre vive déposée ensuite dans la MÊME boîte est portée : l'instrument voit sa cible.
test("une lettre calme (sans_reveil = 1) n'est pas portée par le Facteur ; la lettre vive de la même boîte l'est", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-bob" });
  insertMessage(db, { msg_id: "L-calme", sender: "alice", recipient: "bob", body: "quiet letter", sans_reveil: 1 });
  assert.equal(
    db.prepare("SELECT sans_reveil FROM messages WHERE msg_id = 'L-calme'").get().sans_reveil,
    1,
    "SONDE IMPOSSIBLE : insertMessage n'écrit pas sans_reveil (Tâche 2)"
  );

  const guichet = guichetDeCarton();
  const deps = depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre });
  const calme = await faireLaTournee(db, deps);
  assert.equal(calme.prises, 0, "le Facteur ne prend même pas la lettre calme");
  assert.equal(calme.remises, 0);
  assert.equal(guichet.remises.length, 0, "aucune enveloppe tendue à la boîte");
  assert.equal(db.prepare("SELECT carried_at FROM messages WHERE msg_id = 'L-calme'").get().carried_at, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM facteur_attempts").get().n, 0, "aucune tentative, même close");

  insertMessage(db, { msg_id: "L-vive", sender: "alice", recipient: "bob", body: "loud letter" });
  const vive = await faireLaTournee(db, deps);
  assert.equal(vive.prises, 1, "l'instrument porte bien une lettre vive : le silence d'au-dessus n'est pas une panne");
  assert.equal(vive.remises, 1);
  assert.equal(guichet.remises.length, 1);
  assert.equal(db.prepare("SELECT carried_at FROM messages WHERE msg_id = 'L-calme'").get().carried_at, null, "et la calme reste intacte");
  assert.ok(db.prepare("SELECT carried_at FROM messages WHERE msg_id = 'L-vive'").get().carried_at);
});

// Le mode une-lettre DIT pourquoi il ne porte pas une lettre calme (revue T4, mineur 3) : l'état
// dérivé reste celui du Facteur (PRÊTE : ni réservée, ni différée), et l'événement porte
// `calme: true` — un opérateur qui demande « pourquoi pas portée » ne lit jamais un PRÊTE nu.
// Le contrôle : une lettre vive refusée pour une autre raison (accusée) ne porte pas le marqueur.
test("le mode une-lettre sur une lettre calme : rien n'est porté, et le journal dit calme: true", async (t) => {
  const db = bureauDePoste(t);
  const boite = chaise(db, { lignee: "bob", session: "s-bob" });
  insertMessage(db, { msg_id: "L-calme", sender: "alice", recipient: "bob", body: "quiet letter", sans_reveil: 1 });
  insertMessage(db, { msg_id: "L-accusee", sender: "alice", recipient: "bob", body: "acked letter" });
  db.prepare("UPDATE messages SET acked_at = ? WHERE msg_id = 'L-accusee'").run(new Date().toISOString());

  const tournee = async (msgId) => {
    const lignes = [];
    const guichet = guichetDeCarton();
    const bilan = await faireLaTournee(
      db,
      depsDeBase({ tourHouses: inventaire([boite]), remettreAuGuichet: guichet.remettre, journal: (l) => lignes.push(l), seulementLaLettre: msgId })
    );
    return { bilan, guichet, dit: lignes.find((l) => l.evenement === "facteur_lettre_non_prise") };
  };

  const calme = await tournee("L-calme");
  assert.equal(calme.bilan.prises, 0, "le mode une-lettre ne force pas une lettre calme");
  assert.equal(calme.guichet.remises.length, 0);
  assert.equal(calme.bilan.motifs["lettre-non-prise"], 1);
  assert.ok(calme.dit, "le journal dit que la lettre demandée n'a pas été prise");
  assert.equal(calme.dit.etat, "PRÊTE", "l'état du Facteur, dérivé comme avant");
  assert.equal(calme.dit.calme, true, "et la raison : c'est une lettre calme");

  const accusee = await tournee("L-accusee");
  assert.equal(accusee.dit.etat, "ACCUSÉE");
  assert.equal("calme" in accusee.dit, false, "une lettre vive ne porte pas le marqueur");
});

// ── LE CANAL DE REPLI ──────────────────────────────────────────────────────────────────────────
// `getPendingForContext` SERT la lettre calme (c'est par là qu'elle arrive). L'option
// `sansLesCalmes` est la question du filet du Stop : parmi les lettres qui RÉVEILLENT, la plus
// urgente. Le filtre tombe dans SQLite, avant le tri et la borne : une calme ne masque jamais une
// vive, et une vive n'est jamais masquée par le filtre.
test("une lettre calme est servie par getPendingForContext ; sansLesCalmes l'écarte avant le tri", (t) => {
  const db = bureauDePoste(t);
  insertMessage(db, { msg_id: "L-calme", sender: "alice", recipient: "bob", body: "quiet", sans_reveil: 1 });
  insertMessage(db, { msg_id: "L-vive", sender: "alice", recipient: "bob", body: "loud" });
  assert.deepEqual(
    getPendingForContext(db, "bob").map((r) => r.msg_id),
    ["L-calme", "L-vive"],
    "le canal de repli sert les deux : rien n'est perdu (A9)"
  );
  assert.deepEqual(getPendingForContext(db, "bob", { sansLesCalmes: true }).map((r) => r.msg_id), ["L-vive"]);
  assert.deepEqual(
    getPendingForContext(db, "bob", { limit: 1, parUrgence: true, sansLesCalmes: true }).map((r) => r.msg_id),
    ["L-vive"],
    "la question du Stop : la plus urgente parmi les vives, même avec LIMIT 1"
  );
});

// ── LE FILET DU STOP ───────────────────────────────────────────────────────────────────────────
// Une lettre calme de priorité normale ne retient pas un Stop ; la lettre VIVE de même priorité,
// déposée ensuite dans la même boîte, le retient — et la raison nomme la vive, jamais la calme.
test("le filet du Stop ne bloque pas pour une lettre calme ; il bloque pour la lettre vive de même priorité", (t) => {
  const db = bureauDePoste(t);
  const root = db.racine;
  insertMessage(db, { msg_id: "L-calme", sender: "bob", recipient: "alice", body: "quiet normal letter", sans_reveil: 1 });
  db.close();

  const calme = runHook("safety_net_poll.js", root, { hook_event_name: "Stop" });
  assert.equal(calme.status, 0, calme.stderr);
  assert.deepEqual(JSON.parse(calme.stdout), {}, "aucun blocage pour une lettre calme");

  const db2 = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db2, { msg_id: "L-vive", sender: "bob", recipient: "alice", body: "loud normal letter" });
  db2.close();
  const vive = runHook("safety_net_poll.js", root, { hook_event_name: "Stop" });
  assert.equal(vive.status, 2, "l'instrument bloque bien pour une lettre vive");
  const { reason } = JSON.parse(vive.stderr);
  assert.match(reason, /loud normal letter/);
  assert.doesNotMatch(reason, /quiet normal letter/, "la raison ne cite jamais la calme");
});

// ── LE REPLI, DE BOUT EN BOUT ──────────────────────────────────────────────────────────────────
for (const [script, evenement] of [["piggyback_fetch.js", "PostToolUse"], ["startup_sync.js", "SessionStart"]]) {
  test(`${evenement} sert la lettre calme comme les autres, et la marque livrée`, (t) => {
    const db = bureauDePoste(t);
    const root = db.racine;
    insertMessage(db, { msg_id: "L-calme", sender: "bob", recipient: "alice", body: "quiet letter arrives", sans_reveil: 1 });
    db.close();

    const r = runHook(script, root, { hook_event_name: evenement });
    assert.equal(r.status, 0, r.stderr);
    const sortie = JSON.parse(r.stdout);
    assert.equal(sortie.hookSpecificOutput.hookEventName, evenement);
    assert.match(sortie.hookSpecificOutput.additionalContext, /quiet letter arrives/);

    const db2 = openDatabase({ file: path.join(root, "broker.db") });
    assert.ok(db2.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-calme'").get().delivered_at, "servie, donc marquée livrée");
    db2.close();
  });
}

// Et par `inbox` (le guichet MCP) : la troisième porte du repli sert la calme comme les autres.
test("inbox sert la lettre calme comme les autres", async (t) => {
  const db = bureauDePoste(t);
  const root = db.racine;
  insertMessage(db, { msg_id: "L-calme", sender: "bob", recipient: "alice", body: "quiet letter by inbox", sans_reveil: 1 });
  db.close();
  const c = await clientNu(root, "alice");
  try {
    const boite = await outil(c, "inbox");
    assert.equal(boite.erreur, undefined, boite.erreur);
    assert.deepEqual(boite.messages.map((l) => l.msg_id), ["L-calme"], "la calme est dans la boîte");
  } finally {
    await c.close();
  }
  const db2 = openDatabase({ file: path.join(root, "broker.db") });
  assert.ok(db2.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-calme'").get().delivered_at, "servie, donc marquée livrée");
  db2.close();
});
