// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'ADRESSE HUMAINE — `lignée@nom-de-session`.
//
// `claude-alice#00000000-0000-4000-8000-000000000000` est exact et illisible.
// « claude-alice@atelier » est ce que l'humain dit à voix haute. Les deux
// mènent au même endroit, et le premier ne bouge pas d'un octet (Camp B).
//
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) : le
// bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici, et
// AUCUNE fiche de session écrite ici n'a de socket derrière elle.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "../src/lib/database.js";
import { adressesDuRepli, nomDeSession, touchSelf } from "../src/lib/identity.js";
import {
  deposerAncienNom,
  designatePrimary,
  instanceId,
  porteDeReveil,
  registerInstance,
  resolveRecipient
} from "../src/lib/registry.js";
import { poserLeBureau } from "./aide-env.js";

// I1 (revue finale, 28/09) : la résolution consulte la VIE de la chaise
// désignée. Une chaise censée vivre porte donc un pid vivant (celui de ce
// runner), jamais un numéro inventé (111, 222…) qui est mort — ou vivant par
// hasard — sur une vraie machine.
const PID_VIVANT = process.pid;


const T0 = "2026-08-13T10:00:00.000Z";

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-adresse-"));
  poserLeBureau(root);
  return root;
}

function bureauDePoste(t) {
  const root = tempHome();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return db;
}

// Une maison avec son registre de sessions — des FICHIERS, rien de vivant :
// `messagingSocketPath` est une chaîne, aucun socket n'est ouvert nulle part.
function maisonAvecFiche(t, { fichier, pid, sessionId, name }) {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-maison-"));
  fs.mkdirSync(path.join(maison, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(maison, "sessions", fichier),
    JSON.stringify({ pid, sessionId, name, kind: "interactive", messagingSocketPath: `/tmp/aucun-socket/${pid}.sock` })
  );
  const avant = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = maison;
  t.after(() => {
    if (avant === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = avant;
  });
  return maison;
}

// ── LE GUICHET : `lignée@nom` ───────────────────────────────────────────────

test("le registre garde le nom humain d'une session, tel qu'il s'écrit", (t) => {
  const db = bureauDePoste(t);
  const fiche = registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "  Atelier  "
  });
  assert.equal(fiche.session_name, "Atelier", "on range le nom, on ne le réécrit pas");
});

test("un nom inconnu se dit NULL : un nom ne s'invente pas", (t) => {
  const db = bureauDePoste(t);
  const fiche = registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", pid: PID_VIVANT });
  assert.equal(fiche.session_name, null);
});

test("« lignée@nom » mène à la chaise qui porte ce nom", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/work", pid: PID_VIVANT, sessionName: "veille" });

  const res = resolveRecipient(db, "claude-alice@atelier");
  assert.equal(res.kind, "instance");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id), ["s-1"]);
});

test("l'identifiant technique et le nom de lignée seul marchent EXACTEMENT comme avant", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });

  const parChaise = resolveRecipient(db, instanceId("claude-alice", "s-1"));
  assert.equal(parChaise.kind, "instance");
  assert.equal(parChaise.targets[0].instance_session_id, "s-1");

  const parLignee = resolveRecipient(db, "claude-alice");
  assert.equal(parLignee.kind, "lineage");
  assert.equal(parLignee.targets[0].instance_session_id, "s-1");
});

test("deux boîtes vivantes au même nom : la lettre ATTEND, on n'invente pas de gagnant", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-work", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-b", house: "/h/b", pid: PID_VIVANT, sessionName: "atelier" });

  const res = resolveRecipient(db, "claude-alice@atelier");
  assert.equal(res.kind, "ambigu");
  assert.deepEqual(res.targets.map((r) => r.instance_session_id).sort(), ["s-b", "s-work"]);
});

test("même la chaise DÉSIGNÉE ne tranche pas un nom porté par deux boîtes", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-work", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-b", house: "/h/b", pid: PID_VIVANT, sessionName: "atelier" });
  designatePrimary(db, "claude-alice", "s-work");

  // La désignation répond à « quelle chaise reçoit le courrier de la LIGNÉE ».
  // Celui qui écrit à `@atelier` pose une AUTRE question, et sa précision a
  // échoué : lui répondre avec la désignation, ce serait répondre à côté avec
  // l'air d'être sûr. La lignée, elle, reste tranchée.
  assert.equal(resolveRecipient(db, "claude-alice@atelier").kind, "ambigu");
  assert.equal(resolveRecipient(db, "claude-alice").kind, "lineage");
});

test("un nom qui ne répond pas ne se rabat PAS sur la lignée", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });

  const res = resolveRecipient(db, "claude-alice@absent");
  assert.equal(res.kind, "unknown", "se rabattre sur la lignée, c'est livrer à quelqu'un qu'on n'a pas nommé");
  assert.deepEqual(res.targets, []);
});

test("la casse et les espaces ne perdent pas une lettre", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "Grand Run" });

  for (const adresse of ["claude-alice@Grand Run", "claude-alice@grand run", "claude-alice@GRAND  RUN", "claude-alice@ grand run "]) {
    const res = resolveRecipient(db, adresse);
    assert.equal(res.kind, "instance", `adresse refusée : ${adresse}`);
    assert.equal(res.targets[0].instance_session_id, "s-1");
  }
});

test("« @nom » sans lignée devant n'est pas une adresse de cette maison", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  assert.equal(resolveRecipient(db, "@atelier").kind, "unknown", "deviner la famille, c'est deviner tout court");
  assert.equal(resolveRecipient(db, "claude-alice@").kind, "unknown");
});

test("une chaise hors service ne répond plus à son nom", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  db.prepare("UPDATE peers SET status='offline' WHERE instance_session_id='s-1'").run();
  assert.equal(resolveRecipient(db, "claude-alice@atelier").kind, "unknown");
});

test("un renommage déplace l'adresse au battement suivant", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier-2" });

  assert.equal(resolveRecipient(db, "claude-alice@atelier-2").kind, "instance");
  assert.equal(resolveRecipient(db, "claude-alice@atelier").kind, "unknown", "un nom rendu ne répond plus");
  assert.equal(resolveRecipient(db, instanceId("claude-alice", "s-1")).kind, "instance", "la chaise, elle, ne bouge jamais");
});

test("un nom qu'on n'a PAS pu lire n'efface pas celui qu'on connaissait", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });

  assert.equal(resolveRecipient(db, "claude-alice@atelier").kind, "instance", "perdre le nom, ce serait perdre l'adresse avec");
});

// ── LES DEUX GESTES ENSEMBLE ────────────────────────────────────────────────

test("un ancien nom de famille marche AVEC le nom de session", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const res = resolveRecipient(db, "alice@atelier");
  assert.equal(res.kind, "instance");
  assert.equal(res.targets[0].instance_session_id, "s-1");
  assert.equal(res.reexpedie, "claude-alice@atelier");
});

test("une famille VIVANTE garde ses adresses : on ne traverse pas la rue avec sa lettre", (t) => {
  const db = bureauDePoste(t);
  // « alice » vit encore, mais personne chez elle ne s'appelle atelier. La
  // réexpédition ne s'applique PAS : le renvoi ne sert que les noms morts.
  registerInstance(db, { lineage: "alice", sessionId: "s-vivante", house: "/h/work", pid: PID_VIVANT, sessionName: "autre" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-ailleurs", house: "/h/b", pid: PID_VIVANT, sessionName: "atelier" });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  assert.equal(resolveRecipient(db, "alice@atelier").kind, "unknown");
});

// ── LA CAPTURE DU NOM : c'est la fiche de session qui sait ──────────────────

test("le nom se lit dans la fiche de session de la maison — sans sonde, sans socket", (t) => {
  const db = bureauDePoste(t);
  maisonAvecFiche(t, { fichier: `${process.ppid}.json`, pid: process.ppid, sessionId: "sess-abc", name: "atelier" });

  touchSelf(db, "claude-alice", { session_id: "sess-abc", cwd: "/w" });

  assert.equal(resolveRecipient(db, "claude-alice@atelier").kind, "instance");
});

test("une fiche rangée sous un autre numéro se retrouve quand même, par sa session", (t) => {
  const db = bureauDePoste(t);
  maisonAvecFiche(t, { fichier: "4242.json", pid: 4242, sessionId: "sess-abc", name: "veille" });

  touchSelf(db, "claude-alice", { session_id: "sess-abc", cwd: "/w" });

  assert.equal(resolveRecipient(db, "claude-alice@veille").kind, "instance");
});

test("la fiche d'un VOISIN ne donne jamais son nom à ma session", (t) => {
  const db = bureauDePoste(t);
  maisonAvecFiche(t, { fichier: "4242.json", pid: 4242, sessionId: "sess-du-voisin", name: "veille" });

  touchSelf(db, "claude-alice", { session_id: "sess-abc", cwd: "/w" });

  assert.equal(resolveRecipient(db, "claude-alice@veille").kind, "unknown", "un nom volé au voisin est une lettre livrée à côté");
  assert.equal(nomDeSession("sess-abc"), null, "sans fiche à moi, mon nom est INCONNU — jamais deviné");
});

// ⚠️ CELLE-CI SE PROUVE SUR LE CHEMIN NORMAL, PAS SUR LE REPLI. La garde
// `fiche.sessionId === session` existe DEUX fois : à la branche ① (la fiche à
// mon numéro — un fichier, une lecture, le cas de tous les hooks) et à la
// branche ② (le balayage borné, qui n'est qu'un repli). Le test du dessus fait
// mordre la ②, jamais la ① : la fiche du voisin y est rangée sous un AUTRE
// numéro, donc la ① ne la lit même pas. Retirer la garde de la ① laissait
// l'intégralité du banc vert — la garde la plus empruntée n'était retenue par
// rien.
test("un numéro de processus RECYCLÉ ne donne pas le nom du mort à la vivante (branche ①)", (t) => {
  // macOS boucle à 32768 : le numéro d'une session morte revient à une session
  // vivante, et la fiche périmée l'attend AU NUMÉRO de celle-ci.
  const maison = maisonAvecFiche(t, {
    fichier: "4242.json", pid: 4242, sessionId: "MORTE-0000", name: "atelier"
  });

  assert.equal(
    nomDeSession("VIVANTE-1111", { house: maison, pid: 4242 }),
    null,
    "un nom pris à la fiche d'un mort, c'est « lignée@atelier » livré à côté"
  );
  // Le TÉMOIN : la sonde touche bien sa cible. Sans lui, ce `null` pourrait
  // venir d'une fiche qu'on n'a jamais lue, et le test serait vert pour rien.
  assert.equal(
    nomDeSession("MORTE-0000", { house: maison, pid: 4242 }),
    "atelier",
    "la vraie propriétaire du numéro, elle, se reconnaît : la branche ① est bien celle qu'on éprouve"
  );
});

test("une maison sans registre lisible ne fait pas échouer le battement", (t) => {
  const db = bureauDePoste(t);
  const avant = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "maison-qui-n-existe-pas-cc2cc");
  t.after(() => {
    if (avant === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = avant;
  });

  const fiche = touchSelf(db, "claude-alice", { session_id: "sess-abc", cwd: "/w" });
  assert.equal(fiche.session_name, null);
  assert.equal(resolveRecipient(db, "claude-alice").kind, "lineage", "le courrier passe, nom ou pas");
});

// ── LE REPLI : A8, on préfère un doublon à une lettre perdue ────────────────

test("le repli va chercher le courrier adressé à mon nom humain", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });

  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "s-1" });
  assert.ok(adresses.includes("claude-alice@atelier"), "une adresse qu'aucun repli ne lit est une lettre perdue (A9)");
  // Camp B : les adresses d'avant sont toujours là, dans le même ordre.
  assert.equal(adresses[0], "claude-alice");
  assert.ok(adresses.includes(instanceId("claude-alice", "s-1")));
});

test("le repli ne prend PAS un nom humain que deux boîtes se partagent", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier" });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT, sessionName: "atelier" });

  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "s-1" });
  assert.ok(
    !adresses.includes("claude-alice@atelier"),
    "le guichet dit ATTENDS : le repli ne doit pas ouvrir la porte de derrière"
  );
  // Run 6, Task 7 (27/09) : deux chaises vivantes, aucune désignée — la lettre
  // de la LIGNÉE est tenue (ambiguë), elle aussi : aucune chaise ne la relève
  // comme sienne, chacune n'en voit qu'une copie cc (`copiesPourMoi`).
  assert.ok(!adresses.includes("claude-alice"), "lignée ambiguë : tenue, même garde qu'au « @nom »");
});

test("le repli va chercher le courrier laissé à mes ANCIENS noms (A8)", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "s-1" });
  assert.ok(adresses.includes("alice"), "sept semaines d'attente, c'est ce que coûte un nom qu'aucun repli ne lit");
});

test("le repli ne prend pas l'ancien nom d'une AUTRE famille", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "bob", sessionId: "s-2", house: "/h/hermes", pid: PID_VIVANT });
  deposerAncienNom(db, "bobby", "bob", { now: T0 });

  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "s-1" });
  assert.ok(!adresses.includes("bobby"));
});

test("le repli ne prend pas un ancien nom que quelqu'un porte ENCORE", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  const adresses = adressesDuRepli(db, "claude-alice", { session_id: "s-1" });
  assert.ok(!adresses.includes("alice"), "le courrier de « alice » appartient à qui porte le nom aujourd'hui");
});

// ── LE REPLI N'EST PAS UNE PORTE DE DERRIÈRE ────────────────────────────────
//
// Une garde qui tient à l'entrée principale et fuit ailleurs n'est pas une
// garde. Quand le guichet dit « ambigu », il fait ATTENDRE la lettre : personne
// ne doit l'ouvrir, ni le Facteur, ni le repli. Le nom humain le respectait déjà
// (`estPourMoi`) ; l'ancien nom, lui, se contentait de « suis-je dans la liste
// des candidats ? » — et deux chaises vivantes se voyaient servir LA MÊME lettre,
// chacune de son côté, pour toujours.

test("lignée ambiguë : le repli ne relève PAS l'ancien nom, pas plus que le guichet ne le livre", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  assert.equal(resolveRecipient(db, "alice").kind, "ambigu", "le guichet, lui, fait ATTENDRE la lettre");

  for (const session of ["s-1", "s-2"]) {
    assert.ok(
      !adressesDuRepli(db, "claude-alice", { session_id: session }).includes("alice"),
      `le repli de ${session} ouvre la porte de derrière : la lettre part chez les DEUX`
    );
  }
});

test("la chaise désignée relève l'ancien nom, et elle seule", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });
  designatePrimary(db, "claude-alice", "s-1");

  assert.ok(
    adressesDuRepli(db, "claude-alice", { session_id: "s-1" }).includes("alice"),
    "le geste humain tranche : la désignée reçoit, sinon la lettre n'arriverait jamais"
  );
  assert.ok(
    !adressesDuRepli(db, "claude-alice", { session_id: "s-2" }).includes("alice"),
    // Remède de la revue adverse #3 : « ne lit pas le courrier » surclamait — adressesDuRepli
    // rend des ADRESSES (des noms), jamais du contenu, et ce test ne touche
    // ni insertMessage ni inbox. Ce qu'il prouve vraiment : « alice » n'est
    // PAS dans les adresses de repli de s-2 — le canal d'injection AUTOMATIQUE
    // ne le lui apportera pas. (Une relève EXPLICITE sous ce nom est une
    // question différente, tranchée ailleurs par droitDAccuser.)
    "et « alice » n'est pas dans les adresses de repli de l'autre chaise — le guichet ne l'y met pas"
  );
});

// ── LA PORTE DU RÉVEIL : celle où le moniteur écoute ────────────────────────
//
// Le moniteur d'une session écoute sur `run/<lignée>.sock` — le nom de LIGNÉE,
// et rien d'autre. Frapper au nom écrit sur l'enveloppe, c'est frapper à une
// porte que personne n'a jamais posée : `claude-alice@atelier` devient
// `claude-alice_atelier.sock`, « alice » devient `alice.sock`, et une chaise
// `lignée#session` devient `lignée_session.sock`. Trois adresses livrables, trois
// réveils perdus. La lettre n'est pas perdue pour autant (le repli la rattrape
// au geste suivant), mais « la lettre arrive » et « la lettre arrivera au
// prochain appel d'outil » ne se ressemblent pas quand on attend en direct.
//
// ⚠️ Cette fonction NE FRAPPE À AUCUNE PORTE : elle nomme celle où il faudrait
// frapper. Aucun socket n'est ouvert, ici comme dans tout ce fichier.

test("la porte du réveil est celle du moniteur : la LIGNÉE, pour toutes les formes d'adresse", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier"
  });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  assert.equal(porteDeReveil(db, "claude-alice"), "claude-alice", "le geste d'avant ne bouge pas d'un octet");
  assert.equal(porteDeReveil(db, "claude-alice@atelier"), "claude-alice", "l'adresse humaine réveille sa famille");
  assert.equal(porteDeReveil(db, "alice"), "claude-alice", "un ancien nom aussi");
  assert.equal(
    porteDeReveil(db, instanceId("claude-alice", "s-1")),
    "claude-alice",
    "et une chaise : « # » devient « _ » dans un nom de fichier, ce réveil-là était perdu depuis toujours"
  );
});

test("on ne devine JAMAIS une porte : un nom que personne ne porte garde le sien", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-2", house: "/h/b", pid: PID_VIVANT });

  assert.equal(porteDeReveil(db, "personne"), "personne", "inconnu : on frappe où c'est écrit, comme avant");
  assert.equal(porteDeReveil(db, ""), "", "et un nom vide ne réveille rien");
  // Lignée ambiguë : le guichet ne désigne personne, donc on ne choisit personne.
  // Le nom de famille EST la porte du moniteur : le geste d'avant reste juste.
  assert.equal(porteDeReveil(db, "claude-alice"), "claude-alice");
});

// ── LES DEUX INVARIANTS QUI TIENNENT DES GARDES QU'ON NE PEUT PAS FAIRE ROUGIR ─
//
// Deux lignes du code ne peuvent être mises en défaut par aucune base atteignable
// depuis les gestes publics. Une garde inéprouvable est une garde qui n'existe
// pas : à défaut de faire rougir la LIGNE, on épingle ici l'INVARIANT qui la rend
// aujourd'hui redondante. Le jour où l'invariant tombe, ces tests-là rougissent —
// et ces lignes redeviennent, elles, les seules à tenir la porte.

// ① `estPourMoi` (src/lib/identity.js) refuse sur `kind === "ambigu"` PUIS sur
//    `targets.length !== 1`. La première clause ne peut pas mordre seule, parce
//    qu'aucune ambiguïté ne nomme une seule personne. C'est ça qu'on épingle.
test("INVARIANT — une résolution AMBIGUË ne nomme JAMAIS une seule cible", (t) => {
  const db = bureauDePoste(t);
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-work", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier"
  });
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-b", house: "/h/b", pid: PID_VIVANT, sessionName: "atelier"
  });
  deposerAncienNom(db, "alice", "claude-alice", { now: T0 });

  // Les TROIS chemins par lesquels le guichet peut rendre « ambigu » : la lignée
  // (marche 2), l'adresse humaine (marche 4), et la réexpédition qui hérite de
  // l'une ou de l'autre.
  for (const adresse of ["claude-alice", "claude-alice@atelier", "alice", "alice@atelier"]) {
    const res = resolveRecipient(db, adresse);
    assert.equal(res.kind, "ambigu", `« ${adresse} » devrait faire attendre la lettre`);
    assert.ok(
      res.targets.length >= 2,
      `« ambigu » avec ${res.targets.length} cible pour « ${adresse} » : une ambiguïté qui ne nomme ` +
        "qu'une personne n'en est pas une — et la clause `ambigu` du repli devient alors la seule garde"
    );
  }
});

// ② L'ORDRE des marches du guichet : la fiche héritée (marche 3, Camp B) passe
//    AVANT l'adresse humaine (marche 4, neuve). Rien ne l'épinglait — les deux
//    marches ne se croisent que sur un nom qui contient « @ » ET qui est l'id
//    d'une fiche d'avant les lignées. C'est ce croisement-là qu'on monte ici.
test("INVARIANT — un nom neuf ne passe jamais devant un nom qui marchait déjà", (t) => {
  const db = bureauDePoste(t);
  // Une fiche d'avant les lignées dont l'id porte un « @ » (un roster écrit à la
  // main : rien n'assainit l'id d'un pair, seul le nom de FICHIER l'est).
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('claude-alice@atelier', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  // Et une chaise vivante que l'adresse humaine désignerait, elle aussi.
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier"
  });

  const res = resolveRecipient(db, "claude-alice@atelier");
  assert.equal(res.kind, "instance");
  assert.equal(
    res.targets[0].id,
    "claude-alice@atelier",
    "Camp B : l'adresse qui marchait hier gagne. Sinon une adresse neuve détourne en silence le courrier d'une fiche héritée"
  );
  assert.equal(res.targets[0].instance_session_id, null, "et c'est bien la fiche héritée, pas la chaise");
});
