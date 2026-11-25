// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LA CHASSE AU COURRIER ÉGARÉ (16/11/2026), REPORTÉE SUR LA 1.1.0.
//
// La chasse disait : le nom nu d'une lignée est à la chaise qui la TIENT ; une
// autre session de la même lignée ne le ramasse plus. La 1.1.0 avait déjà cette
// règle (`deciderLaCopie`, 27/09, avec ses copies cc) ; elle reste la règle. Ce
// fichier ne garde que ce que la chasse AJOUTE :
//   · `laLigneeEstTenueParUneAutre(db, sessionId, cible)`, le nom de la question
//     que les crochets posent avant de relever le nom nu ;
//   · seule une chaise VIVANTE tient la lignée (I1 de la chasse) ;
//   · la règle du même processus, vue par cette question ;
//   · un appel servi (`served:`) n'est pas une chaise.
//
// Les autres cas de la chasse vivent déjà ailleurs sur la 1.1.0 :
//   · la lettre au nom nu ne sonne que chez la désignée, de bout en bout :
//     test/hooks.test.js (« lettre à la lignée : livrée à la chaise désignée ») ;
//   · sans session, la boîte garde le nom nu : test/registry.test.js ;
//   · les aides (`agent_id`), `agent_type` seul, le `last_seen` de la chaise :
//     test/garde-aides.test.js ;
//   · la session neuve du processus de la désignée : test/chasse-1-1-0.test.js ;
//   · la désignée morte pas encore moissonnée : test/designee-morte-non-moissonnee.test.js.
// Deux cas de la chasse ne sont PAS reportés, parce que la 1.1.0 les tranche
// autrement, par dessein : quand personne ne tient la lignée (aucune désignée,
// ou une désignée morte), la lettre est TENUE pour la lignée et chaque chaise en
// voit une copie « sans-chaise-designee » (la 1.0.0 la laissait relever par
// toutes, A8). Les tests ci-dessous épinglent cette réponse-là.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-courrier-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});
const { droitDeSigner, insertMessage, openDatabase } = await import("../src/lib/database.js");
const { deciderLaCopieAuRegistre, designatePrimary, registerInstance } = await import("../src/lib/registry.js");
const { ecrireLeCarnet } = await import("../src/lib/relais/carnet.js");
const { adressesDuRepli, copiesPourChaise, estUnAppelServi, laLigneeEstTenueParUneAutre } = await import("../src/lib/identity.js");

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function bureau(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-courrier-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* bureau jetable */ } });
  return { root, db };
}

// Deux chaises = deux processus vivants distincts (le parent du test et le
// test lui-même) : un même processus ne porte qu'une session à la fois.
function deuxChaises(db) {
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: process.ppid });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/opt/valxos/h2", pid: process.pid });
}

test("① la lignée est tenue par une AUTRE : la désignée vivante d'un autre processus ; la désignée elle-même ne l'est pas", (t) => {
  const { db } = bureau(t);
  deuxChaises(db);
  designatePrimary(db, "alice", "s-1");
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", "alice"), true, "la sœur : la lignée est à une autre");
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-1", "alice"), false, "la désignée : la lignée est à elle");
  // La décision du nom nu dit la même chose que la question.
  const soeur = adressesDuRepli(db, "alice", { session_id: "s-2" });
  assert.ok(!soeur.includes("alice"), "la sœur ne relève pas le nom nu");
  assert.ok(soeur.includes("alice#s-2"), "elle garde son adresse de chaise");
  assert.ok(adressesDuRepli(db, "alice", { session_id: "s-1" }).includes("alice"), "la désignée relève le nom nu");
});

test("① sans session ou sans nom, la question ne se pose pas : non", (t) => {
  const { db } = bureau(t);
  deuxChaises(db);
  designatePrimary(db, "alice", "s-1");
  assert.equal(laLigneeEstTenueParUneAutre(db, null, "alice"), false);
  assert.equal(laLigneeEstTenueParUneAutre(db, "", "alice"), false);
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", ""), false);
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", "   "), false);
});

test("① personne ne tient la lignée (deux chaises, aucune désignée) : aucune AUTRE ne la tient, et la 1.1.0 la tient pour la lignée", (t) => {
  const { db } = bureau(t);
  deuxChaises(db);
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-1", "alice"), false);
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", "alice"), false);
  // La règle de la 1.1.0 (`deciderLaCopie`, « sans-chaise-designee ») : la
  // lettre attend une désignation, chaque chaise n'en voit qu'une copie.
  assert.ok(!adressesDuRepli(db, "alice", { session_id: "s-1" }).includes("alice"));
  assert.ok(!adressesDuRepli(db, "alice", { session_id: "s-2" }).includes("alice"));
});

test("① une lignée que personne ne porte n'est tenue par personne", (t) => {
  const { db } = bureau(t);
  registerInstance(db, { lineage: "bob", sessionId: "s-b", house: "/opt/valxos/hb", pid: process.pid });
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-b", "alice"), false);
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-inconnue", "alice"), false);
});

test("① une lignée tenue sur l'autre Mac n'est pas tenue par une autre chaise d'ICI (c'est `laLigneeEstTenueAilleurs`)", (t) => {
  const { db } = bureau(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: process.pid });
  designatePrimary(db, "alice", "s-1");
  db.prepare("UPDATE peers SET designe_at = ? WHERE id = 'alice#s-1'").run("2026-11-16T10:00:00.000Z");
  ecrireLeCarnet(db, "Studio", [
    { chaise_id: "alice#s-9", lineage: "alice", instance_session_id: "s-9", is_primary: 1, designe_at: "2026-11-16T11:00:00.000Z" }
  ], { at: "2026-11-16T12:00:00.000Z" });
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-1", "alice"), false, "aucune chaise d'ici ne la tient");
  assert.ok(!adressesDuRepli(db, "alice", { session_id: "s-1" }).includes("alice"),
    "la règle du relais (cc-distant) retire quand même le nom nu : la lettre est à porter");
});

// ── I1 DE LA CHASSE : SEULE UNE CHAISE VIVANTE TIENT LA LIGNÉE ──────────────
// La 1.1.0 ne donnait déjà plus la lignée à une désignée MORTE (I1 du guichet,
// 28/09 : la lettre est tenue pour la lignée). Restait la désignée dont on ne
// sait rien (sans PID, ou une sonde muette) : elle tenait encore la lignée, la
// sœur n'en voyait qu'une copie, et la lettre attendait une chaise qui ne la
// relèverait peut-être jamais. Elle ne la tient plus : la sœur garde le nom nu
// (A8, un doublon plutôt qu'une lettre perdue), sans copie, et peut l'accuser.
function soeurEtDesigneeSansPid(db) {
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: 0 });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/opt/valxos/h2", pid: process.pid });
  designatePrimary(db, "alice", "s-1");
}

test("① une désignée SANS PID (indécidable) ne tient pas la lignée : la sœur garde le nom nu, sans copie, et peut l'accuser", (t) => {
  const { db } = bureau(t);
  soeurEtDesigneeSansPid(db);
  insertMessage(db, { sender: "bob", recipient: "alice", body: "pour la lignée" });
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", "alice"), false, "on ne sait pas qu'elle vit : elle ne tient pas");
  assert.ok(adressesDuRepli(db, "alice", { session_id: "s-2" }).includes("alice"), "la sœur relève le nom nu (A8)");
  assert.equal(copiesPourChaise(db, "alice", "s-2").rows.length, 0, "ce n'est pas une copie pour elle");
  assert.equal(droitDeSigner(db, "alice", "alice#s-2").autorise, true, "elle peut l'accuser");
  assert.ok(adressesDuRepli(db, "alice", { session_id: "s-1" }).includes("alice"), "la désignée, si elle parle, la relève aussi");
});

test("① une désignée que la sonde ne sait pas dire ne tient pas la lignée ; vivante, elle la tient ; la sonde ne tourne que pour une copie", (t) => {
  const { db } = bureau(t);
  deuxChaises(db);
  designatePrimary(db, "alice", "s-1");
  const pour = (etat) => deciderLaCopieAuRegistre(db, {
    lignee: "alice", sessionId: "s-2", pidDeMaChaise: process.pid, sonde: () => ({ etat, raison: "sonde-de-test" })
  });
  assert.equal(pour("vivante").raison, "cc");
  assert.equal(pour("vivante").copie, true);
  assert.equal(pour("indecidable").raison, "designee-pas-vivante");
  assert.equal(pour("indecidable").copie, false);
  assert.equal(pour("indecidable").chaise_designee, "alice#s-1");
  assert.equal(pour("morte").raison, "designee-pas-vivante");
  let sondes = 0;
  const compter = () => { sondes += 1; return { etat: "morte", raison: "sonde-de-test" }; };
  assert.equal(deciderLaCopieAuRegistre(db, { lignee: "alice", sessionId: "s-1", pidDeMaChaise: process.ppid, sonde: compter }).raison, "destinataire");
  assert.equal(sondes, 0, "la destinataire ne sonde personne");
});

test("① une désignée MORTE pas encore moissonnée : aucune AUTRE ne tient la lignée, et la 1.1.0 tient la lettre pour elle", (t) => {
  const { db } = bureau(t);
  const parti = spawnSync("true").pid; // un processus déjà terminé : son numéro ne vit plus
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: parti });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/opt/valxos/h2", pid: process.pid });
  designatePrimary(db, "alice", "s-1");
  insertMessage(db, { sender: "bob", recipient: "alice", body: "pour la lignée" });
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-2", "alice"), false);
  assert.ok(!adressesDuRepli(db, "alice", { session_id: "s-2" }).includes("alice"), "tenue pour la lignée (I1 du guichet)");
  assert.equal(copiesPourChaise(db, "alice", "s-2").sansChaiseDesignee, true, "la copie dit qu'il faut désigner");
});

test("① de bout en bout, désignée sans PID : le filet de fin de tour de la sœur la retient, et son crochet d'après-outil la lui remet", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-courrier-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  soeurEtDesigneeSansPid(db);
  insertMessage(db, { msg_id: "L-sans-pid", sender: "bob", recipient: "alice", body: "pour qui tient alice", priority: "high" });
  db.close();
  // Le crochet est l'enfant de ce processus : son parent est la chaise s-2.
  const crochet = (fichier, evenement) => spawnSync("node", [path.join(repo, "src/hooks", fichier)], {
    input: JSON.stringify({ hook_event_name: evenement, session_id: "s-2", cwd: "/opt/valxos/h2" }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "alice", VALXOS_SELF: "alice" }
  });
  const filet = crochet("safety_net_poll.js", "Stop");
  assert.equal(filet.status, 2, `le filet bloque : la lettre est à elle aussi (${filet.stdout}${filet.stderr})`);
  assert.match(filet.stderr, /pour qui tient alice/);
  const apres = crochet("piggyback_fetch.js", "PostToolUse");
  assert.equal(apres.status, 0, apres.stderr);
  const contexte = JSON.parse(apres.stdout).hookSpecificOutput?.additionalContext || "";
  assert.match(contexte, /pour qui tient alice/);
  assert.doesNotMatch(contexte, /NOT addressed to this session/, "remise, pas montrée en copie");
  const relue = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => relue.close());
  assert.notEqual(relue.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-sans-pid'").get().delivered_at, null);
});

// ── LA RÈGLE DU MÊME PROCESSUS, VUE PAR LA QUESTION ─────────────────────────
// Un processus Claude porte une session à la fois, mais plusieurs de suite
// (`/clear`, un changement de session) : la session neuve du processus de la
// désignée EST la désignée d'aujourd'hui. La règle vit dans `deciderLaCopie`
// depuis la 1.1.0 (test/chasse-1-1-0.test.js) ; la question la lit pareil, et
// ne sonde personne pour elle.
test("① la session NEUVE du processus de la désignée : la lignée n'est pas tenue par une autre ; pour la sœur d'un autre processus, si", (t) => {
  const { db } = bureau(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-ancienne", house: "/opt/valxos/h1", pid: process.ppid });
  designatePrimary(db, "alice", "s-ancienne");
  registerInstance(db, { lineage: "alice", sessionId: "s-neuve", house: "/opt/valxos/h1", pid: process.ppid });
  registerInstance(db, { lineage: "alice", sessionId: "s-soeur", house: "/opt/valxos/h2", pid: process.pid });
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-neuve", "alice"), false, "le même processus tient la lignée");
  assert.equal(laLigneeEstTenueParUneAutre(db, "s-soeur", "alice"), true, "une sœur d'un autre processus, non");
  let sondes = 0;
  const compter = () => { sondes += 1; return { etat: "morte", raison: "sonde-de-test" }; };
  const verdict = deciderLaCopieAuRegistre(db, { lignee: "alice", sessionId: "s-neuve", pidDeMaChaise: process.ppid, sonde: compter });
  assert.equal(verdict.raison, "destinataire-meme-processus");
  assert.equal(sondes, 0, "le même processus ne sonde personne");
});

// ── UN APPEL SERVI N'EST PAS UNE CHAISE ─────────────────────────────────────
// Claude Code 2.1.325 exécute un appel d'outil servi pour une autre session
// dans le processus hôte, avec `session_id: "served:<appelant>"` (relecture
// adverse du 16/11, cas P2). Il partage donc le PID de la chaise qui l'héberge :
// sans garde, la règle du même processus lui donnait la lettre de la lignée, et
// il s'inscrivait comme chaise `lignée#served:…`. Les crochets le refusent
// (hook-common.js, depuis la 1.1.0) ; la question et la boîte aussi.
test("② un appel servi dans le processus de la désignée : rien relevé, rien inscrit, aucun Stop retenu, et la désignée garde sa lettre", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "valxos-chasse-courrier-"));
  const db = openDatabase({ file: path.join(root, "broker.db") });
  // La désignée vit dans CE processus : le parent des crochets lancés ci-dessous.
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: process.pid });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/opt/valxos/h2", pid: process.ppid });
  designatePrimary(db, "alice", "s-1");
  insertMessage(db, { msg_id: "L-servi", sender: "bob", recipient: "alice", body: "pour la désignée", priority: "high" });
  db.close();
  const crochet = (fichier, sessionId, evenement) => spawnSync("node", [path.join(repo, "src/hooks", fichier)], {
    input: JSON.stringify({ hook_event_name: evenement, session_id: sessionId, cwd: "/opt/valxos/h1" }),
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "alice", VALXOS_SELF: "alice" }
  });
  const servi = crochet("piggyback_fetch.js", "served:caller-x", "PostToolUse");
  assert.equal(servi.status, 0, servi.stderr);
  assert.deepEqual(JSON.parse(servi.stdout), {}, "l'appel servi ne voit pas la lettre");
  const filet = crochet("safety_net_poll.js", "served:caller-x", "Stop");
  assert.equal(filet.status, 0, filet.stderr);
  assert.deepEqual(JSON.parse(filet.stdout), {}, "le filet ne retient pas un appel servi");
  const relue = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => relue.close());
  assert.equal(relue.prepare("SELECT COUNT(*) AS n FROM peers WHERE id LIKE '%served:%' OR instance_session_id LIKE 'served:%'").get().n, 0,
    "aucune chaise `served:` au registre");
  assert.equal(relue.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-servi'").get().delivered_at, null, "rien n'est marqué remis");
  const chezLaDesignee = crochet("piggyback_fetch.js", "s-1", "PostToolUse");
  assert.match(JSON.parse(chezLaDesignee.stdout).hookSpecificOutput?.additionalContext || "", /pour la désignée/);
});

test("② un appel servi n'a pas de boîte, et la question ne se pose pas pour lui", (t) => {
  const { db } = bureau(t);
  registerInstance(db, { lineage: "alice", sessionId: "s-1", house: "/opt/valxos/h1", pid: process.ppid });
  designatePrimary(db, "alice", "s-1");
  assert.equal(estUnAppelServi("served:caller-x"), true);
  assert.equal(estUnAppelServi("s-1"), false);
  assert.equal(estUnAppelServi(null), false);
  assert.equal(estUnAppelServi("xserved:caller-x"), false, "le préfixe, et rien d'autre");
  assert.deepEqual(adressesDuRepli(db, "alice", { session_id: "served:caller-x" }), [],
    "ni le nom nu, ni une chaise `alice#served:…`");
  assert.equal(laLigneeEstTenueParUneAutre(db, "served:caller-x", "alice"), false,
    "ce n'est pas une chaise : la question ne se pose pas (et ce non n'ouvre aucune boîte)");
});
