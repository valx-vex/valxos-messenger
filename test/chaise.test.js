// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// La chaise : le seul geste humain du design, et sa porte.
// Toutes les bases de ce fichier sont JETABLES (mkdtemp + CC2CC_V2_HOME) :
// le bureau de poste vivant (~/.cc2cc-v2/broker.db) n'est JAMAIS ouvert ici.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { insertMessage, openDatabase } from "../src/lib/database.js";
import { registerInstance, resolveRecipient, designatePrimary } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// I1 (revue finale, 28/09) : la résolution consulte la VIE de la chaise
// désignée. Une chaise censée vivre porte donc un pid vivant (celui de ce
// runner), jamais un numéro inventé (111, 222…) qui est mort — ou vivant par
// hasard — sur une vraie machine.
const PID_VIVANT = process.pid;


// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-chaise-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repoRacine = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-v2-chaise-"));
}

function chaise(root, ...argv) {
  return spawnSync("node", [path.join(repoRacine, "src/bin/valxos-chaise.js"), ...argv], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root }
  });
}

// Deux chaises vivantes, une lettre en attente, et personne de désigné.
function bureauDePoste(t) {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, {
    lineage: "alice", sessionId: "35e98d0b-3f2c-4d66-9fa6-08608bb889cf", house: "/h/work", pid: PID_VIVANT
  });
  registerInstance(db, {
    lineage: "alice", sessionId: "7a11e4e0-1111-2222-3333-444455556666", house: "/h/b", pid: PID_VIVANT
  });
  insertMessage(db, {
    msg_id: "L1", sender: "bob", recipient: "alice", body: "SECRET-DU-COURRIER"
  });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { root, db };
}

test("la lignée ambiguë s'affiche comme telle, et l'outil dit comment trancher", (t) => {
  const { root } = bureauDePoste(t);
  const res = chaise(root, "chaises", "alice");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /2 chair\(s\) in service/);
  assert.match(res.stdout, /35e98d0b-3f2c-4d66-9fa6-08608bb889cf/);
  assert.match(res.stdout, /7a11e4e0-1111-2222-3333-444455556666/);
  assert.match(res.stdout, /WAITS/, "une lignée sans chaise désignée doit le DIRE");
  assert.match(res.stdout, /valxos-chaise moissonner/, "I-3 : le second remède (la moisson) est nommé aussi");
  assert.match(res.stdout, /valxos-chaise designer alice/);
});

// « seen never » se lisait à l'envers (18/10). Une chaise vue dit « seen
// <instant> » ; une fiche héritée sans aucune trace de vie dit « never seen ».
test("la ligne d'une chaise dit « seen <instant> », ou « never seen » sans aucune trace", (t) => {
  const { root, db } = bureauDePoste(t);
  db.prepare("UPDATE peers SET heartbeat_at = NULL, last_seen = '' WHERE instance_session_id = ?")
    .run("7a11e4e0-1111-2222-3333-444455556666");
  const res = chaise(root, "chaises", "alice");
  assert.equal(res.status, 0, res.stderr);
  const ligne = (id) => res.stdout.split("\n").find((l) => l.includes(id)) || "";
  assert.match(ligne("35e98d0b-3f2c-4d66-9fa6-08608bb889cf"), /\bseen \d{4}-\d{2}-\d{2}T/, "une chaise vue dit quand");
  assert.match(ligne("7a11e4e0-1111-2222-3333-444455556666"), /\bnever seen\b/, "une chaise sans trace le dit dans l'ordre anglais");
  assert.doesNotMatch(res.stdout, /seen never/);
});

test("désigner une chaise tranche la lignée, et ça se voit dans le registre", (t) => {
  const { root, db } = bureauDePoste(t);
  assert.equal(resolveRecipient(db, "alice").kind, "ambigu");

  const res = chaise(root, "designer", "alice", "35e98d0b");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /← DESIGNATED/);

  const apres = resolveRecipient(db, "alice");
  assert.equal(apres.kind, "lineage");
  assert.equal(apres.targets[0].instance_session_id, "35e98d0b-3f2c-4d66-9fa6-08608bb889cf");
});

test("un début de session qui répond pour deux chaises est REFUSÉ, sans rien changer", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "alice", sessionId: "35e98d0b-aaaa", house: "/h/work", pid: 1 });
  registerInstance(db, { lineage: "alice", sessionId: "35e98d0b-bbbb", house: "/h/b", pid: PID_VIVANT });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  const res = chaise(root, "designer", "alice", "35e98d0b");
  assert.notEqual(res.status, 0, "on ne devine pas une chaise");
  assert.match(res.stderr, /matches 2 chairs/);
  assert.match(res.stderr, /35e98d0b-aaaa/);
  assert.match(res.stderr, /35e98d0b-bbbb/);
  assert.equal(resolveRecipient(db, "alice").kind, "ambigu", "un refus ne désigne personne");
  assert.equal(db.prepare("SELECT count(*) n FROM peers WHERE is_primary = 1").get().n, 0);
});

test("rendre la chaise remet la lignée en attente", (t) => {
  const { root, db } = bureauDePoste(t);
  chaise(root, "designer", "alice", "35e98d0b");
  assert.equal(resolveRecipient(db, "alice").kind, "lineage");

  const res = chaise(root, "liberer", "alice");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(resolveRecipient(db, "alice").kind, "ambigu");
});

test("l'outil n'affiche JAMAIS le contenu d'une lettre, et n'y touche pas", (t) => {
  const { root, db } = bureauDePoste(t);
  const sorties = [
    chaise(root, "lignees"),
    chaise(root, "chaises", "alice"),
    chaise(root, "designer", "alice", "35e98d0b"),
    chaise(root, "chaises", "alice", "--json")
  ];
  for (const res of sorties) {
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes("SECRET-DU-COURRIER"), "la chaise ne lit pas le courrier");
  }
  const lettre = db.prepare("SELECT * FROM messages WHERE msg_id='L1'").get();
  assert.equal(lettre.delivered_at, null, "aucun effet de bord sur le courrier");
  assert.equal(lettre.carried_at, null);
  assert.equal(lettre.acked_at, null);
  assert.equal(lettre.injected_at, null);
});

test("une lignée que personne ne porte donne un refus nommé, jamais un silence", (t) => {
  const { root } = bureauDePoste(t);
  const res = chaise(root, "designer", "personne", "s-1");
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no chair for lineage/);
});

test("la liste des lignées dit lesquelles attendent", (t) => {
  const { root } = bureauDePoste(t);
  const avant = JSON.parse(chaise(root, "lignees", "--json").stdout);
  assert.deepEqual(avant.lignees.map((l) => [l.lineage, l.chaises, l.kind]), [["alice", 2, "ambigu"]]);

  chaise(root, "designer", "alice", "7a11e4e0");
  const apres = JSON.parse(chaise(root, "lignees", "--json").stdout);
  assert.equal(apres.lignees[0].kind, "lineage");
  assert.equal(apres.lignees[0].designee, "7a11e4e0-1111-2222-3333-444455556666");
});

test("sans commande, l'outil explique — il ne fait rien", (t) => {
  const { root, db } = bureauDePoste(t);
  const res = chaise(root);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /valxos-chaise designer/);
  assert.equal(db.prepare("SELECT count(*) n FROM peers WHERE is_primary = 1").get().n, 0);
});

// --- Les anciens noms et l'adresse humaine, vus du guichet -------------------

test("l'outil montre le nom humain de chaque chaise : c'est ce qu'on tape", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, {
    lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT, sessionName: "atelier"
  });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  const res = chaise(root, "chaises", "claude-alice");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atelier/, "une adresse qu'on ne voit nulle part ne se tape jamais");
  assert.match(res.stdout, /claude-alice@atelier/, "l'outil montre l'adresse ENTIÈRE, prête à copier");

  const json = JSON.parse(chaise(root, "chaises", "claude-alice", "--json").stdout);
  assert.equal(json.chaises[0].nom, "atelier");
  assert.equal(json.chaises[0].adresse, "claude-alice@atelier");
});

test("poser un ancien nom se fait par l'outil, et ça se voit tout de suite", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  const res = chaise(root, "reexpedier", "alice", "claude-alice");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(resolveRecipient(db, "alice").kind, "lineage");

  const liste = JSON.parse(chaise(root, "anciens-noms", "--json").stdout);
  assert.deepEqual(liste.anciens_noms.map((r) => [r.ancien_nom, r.lignee]), [["alice", "claude-alice"]]);
  assert.match(chaise(root, "chaises", "claude-alice").stdout, /alice/);
});

test("l'outil REFUSE une réexpédition qui bouclerait, et il dit pourquoi", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  assert.equal(chaise(root, "reexpedier", "a", "b").status, 0);
  const res = chaise(root, "reexpedier", "b", "a");
  assert.notEqual(res.status, 0, "on ne pose pas un renvoi qui tourne en rond");
  assert.match(res.stderr, /loop/i);
  assert.equal(db.prepare("SELECT count(*) n FROM anciens_noms").get().n, 1, "un refus n'écrit rien");
});

test("poser un ancien nom que quelqu'un porte ENCORE prévient au lieu de mentir", (t) => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  registerInstance(db, { lineage: "alice", sessionId: "s-vivante", house: "/h/work", pid: PID_VIVANT });
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/b", pid: PID_VIVANT });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });

  const res = chaise(root, "reexpedier", "alice", "claude-alice");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /still carries this name/i, "un renvoi qui ne servira pas doit le DIRE");
  assert.equal(resolveRecipient(db, "alice").targets[0].instance_session_id, "s-vivante");
});

// ⚠️ LE PIÈGE QUI FAIT RATER UNE CÉRÉMONIE EN SILENCE.
//
// La lettre du 22/07 a été adressée à l'ancien nom court d'une lignée, parce
// que ce nom était un pair ENREGISTRÉ. Camp B ne supprime rien : cette fiche
// est encore là, et le guichet la sert (marche 3) AVANT toute réexpédition. Le renvoi est alors posé,
// vert, et parfaitement INERTE — et le fantôme de juillet ne s'éteindra jamais
// tout seul. Pire : la colonne d'état affiche `instance` dans les DEUX cas, celui
// du renvoi qui sert comme celui du renvoi qui ne sert pas. Ce qui les sépare,
// c'est que le guichet nomme la réexpédition quand elle a servi.

function bureauFantome(t) {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  // La fiche de juillet : un pair d'avant les lignées, jamais retiré du service.
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('alice', 'active', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
  `).run();
  registerInstance(db, { lineage: "claude-alice", sessionId: "s-1", house: "/h/work", pid: PID_VIVANT });
  t.after(() => { try { db.close(); } catch { /* base jetable */ } });
  return { root, db };
}

test("un renvoi qu'une fiche héritée rend INERTE le dit, et nomme le remède", (t) => {
  const { root, db } = bureauFantome(t);

  const res = chaise(root, "reexpedier", "alice", "claude-alice");
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /INERT/, "un renvoi qui ne sert pas doit le dire");
  assert.match(
    res.stdout,
    /valxos-unregister --id alice/,
    "un remède qu'on ne nomme pas est un piège : le fantôme de juillet ne s'éteindra jamais seul"
  );
  assert.equal(resolveRecipient(db, "alice").reexpedie, undefined, "et le fait est vrai : la réexpédition ne sert pas");
});

test("le PRÉ-VOL sépare un renvoi qui sert d'un renvoi inerte — la colonne d'état ne suffit pas", (t) => {
  const { root, db } = bureauFantome(t);
  // Une autre fiche héritée, celle-là au bout d'un renvoi qui SERT.
  db.prepare(`
    INSERT INTO peers (id, status, registered_at, last_seen)
    VALUES ('bob-2026', 'active', '2026-06-25T00:00:00.000Z', '2026-06-25T00:00:00.000Z')
  `).run();
  chaise(root, "reexpedier", "alice", "claude-alice");   // masqué par le fantôme
  chaise(root, "reexpedier", "bobby", "bob-2026");    // celui-là sert

  // Les deux valent `instance` au guichet, à l'octet près : sans autre colonne,
  // l'opérateur ne peut pas voir lequel des deux le fera rater ce soir.
  assert.equal(resolveRecipient(db, "alice").kind, "instance");
  assert.equal(resolveRecipient(db, "bobby").kind, "instance");

  const json = JSON.parse(chaise(root, "anciens-noms", "--json").stdout);
  const parNom = Object.fromEntries(json.anciens_noms.map((r) => [r.ancien_nom, r]));
  assert.equal(parNom.alice.sert, false, "le renvoi masqué par une fiche héritée NE SERT PAS");
  assert.equal(parNom.alice.masque_par, "fiche-heritee", "et le pré-vol dit QUI le masque");
  assert.equal(parNom.bobby.sert, true, "celui-ci, si");
  assert.equal(parNom.bobby.mene_a, "bob-2026", "et le pré-vol dit où il mène");

  const texte = chaise(root, "anciens-noms").stdout;
  assert.match(texte, /INERT/, "le pré-vol se lit à l'œil nu, pas seulement en JSON");
  assert.match(texte, /valxos-unregister --id alice/, "et il nomme le remède, ligne par ligne");
});

test("l'outil des anciens noms ne touche toujours pas au courrier", (t) => {
  const { root, db } = bureauDePoste(t);
  const sorties = [
    chaise(root, "reexpedier", "vieille-alice", "alice"),
    chaise(root, "anciens-noms"),
    chaise(root, "anciens-noms", "--json")
  ];
  for (const res of sorties) {
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!res.stdout.includes("SECRET-DU-COURRIER"));
  }
  const lettre = db.prepare("SELECT * FROM messages WHERE msg_id='L1'").get();
  assert.equal(lettre.delivered_at, null);
  assert.equal(lettre.carried_at, null);
  assert.equal(lettre.acked_at, null);
});

// Une chaise que la moisson a constatée MORTE n'est plus en service : l'outil
// humain doit la compter comme telle et refuser de la désigner. Sinon le CLI
// dit « désignée » d'une chaise que le routage (EN_SERVICE) ne choisira jamais
// — deux vérités pour un même registre.
test("une chaise morte n'est ni comptée en service, ni désignable", (t) => {
  const { root, db } = bureauDePoste(t);
  db.prepare("UPDATE peers SET status = 'dead', dead_at = ? WHERE instance_session_id = ?")
    .run("2026-08-18T12:00:00.000Z", "7a11e4e0-1111-2222-3333-444455556666");

  const vue = chaise(root, "chaises", "alice");
  assert.equal(vue.status, 0, vue.stderr);
  assert.match(vue.stdout, /1 chair\(s\) in service/, "la morte ne compte pas comme en service");
  assert.match(vue.stdout, /7a11e4e0-1111-2222-3333-444455556666.*\[dead\]/, "et elle est dite MORTE, à l'œil nu");
  assert.doesNotMatch(vue.stdout, /WAITS/, "une lignée avec une seule vivante n'attend personne");

  const res = chaise(root, "designer", "alice", "7a11e4e0");
  assert.equal(res.status, 1, "désigner une morte est refusé");
  assert.match(res.stderr + res.stdout, /out of service|dead/);
  const morte = db.prepare("SELECT is_primary FROM peers WHERE instance_session_id = ?")
    .get("7a11e4e0-1111-2222-3333-444455556666");
  assert.equal(Number(morte.is_primary), 0, "et le registre n'a pas bougé");

  const json = JSON.parse(chaise(root, "chaises", "alice", "--json").stdout);
  assert.equal(json.designee, null);
  assert.equal(json.chaises.find((c) => c.session.startsWith("7a11e4e0")).statut, "dead");
});

// Le bureau de poste veuf : deux chaises vivantes, et une désignée MORTE qui
// porte encore sa désignation — le cas réel d'une désignée partie, rejoué
// sur base jetable.
function bureauVeuf(t) {
  const { root, db } = bureauDePoste(t);
  registerInstance(db, {
    lineage: "alice", sessionId: "cccc3333-0000-4000-8000-000000000003", house: "/h/work", pid: PID_VIVANT
  });
  designatePrimary(db, "alice", "cccc3333-0000-4000-8000-000000000003");
  db.prepare("UPDATE peers SET status = 'dead', dead_at = '2026-08-18T12:00:00Z' WHERE instance_session_id = 'cccc3333-0000-4000-8000-000000000003'").run();
  return { root, db };
}

test("lignees dit « désignée morte », pas un « ambiguë » muet", (t) => {
  const { root } = bureauVeuf(t);
  const sortie = chaise(root, "lignees");
  assert.equal(sortie.status, 0, sortie.stderr);
  assert.match(sortie.stdout, /designated chair dead/);
  assert.match(sortie.stdout, /re-designate or harvest/i, "I-3 : les deux remèdes");
});

test("chaises raconte la veuve : qui est morte, depuis quand, et le remède", (t) => {
  const { root } = bureauVeuf(t);
  const sortie = chaise(root, "chaises", "alice");
  assert.equal(sortie.status, 0, sortie.stderr);
  assert.match(sortie.stdout, /designated chair .*dead/i);
  assert.match(sortie.stdout, /2026-08-18/);
  assert.match(sortie.stdout, /RE-designation/);
  assert.match(sortie.stdout, /valxos-chaise designer alice/);
  assert.match(sortie.stdout, /valxos-chaise moissonner/, "I-3 : la moisson est le second remède, et elle se nomme");
  // Et le JSON porte le fait, pour les yeux machines.
  const json = chaise(root, "chaises", "alice", "--json");
  const contenu = JSON.parse(json.stdout);
  assert.equal(contenu.designee_morte.session, "cccc3333-0000-4000-8000-000000000003");
});

// I-5 (vérification des chaises parallèles, 18/10) : après une moisson, la
// désignée morte garde `is_primary` en base. La flèche « ← DESIGNATED » suit le
// routage réel : une chaise morte n'en porte jamais, et la seule chaise en
// service reçoit sans désignation.
test("après la moisson, la désignée morte ne porte plus la flèche DESIGNATED (I-5)", (t) => {
  const { root, db } = bureauDePoste(t);
  designatePrimary(db, "alice", "7a11e4e0-1111-2222-3333-444455556666");
  db.prepare("UPDATE peers SET status = 'dead', dead_at = '2026-08-18T12:00:00Z' WHERE instance_session_id = ?")
    .run("7a11e4e0-1111-2222-3333-444455556666");
  assert.equal(resolveRecipient(db, "alice").kind, "lineage", "SONDE IMPOSSIBLE : la seule vivante doit recevoir");

  const sortie = chaise(root, "chaises", "alice");
  assert.equal(sortie.status, 0, sortie.stderr);
  const ligneMorte = sortie.stdout.split("\n").find((l) => l.includes("7a11e4e0-1111-2222-3333-444455556666"));
  assert.ok(ligneMorte, `SONDE IMPOSSIBLE : la ligne de la morte manque (${sortie.stdout})`);
  assert.match(ligneMorte, /\[dead\]/);
  assert.doesNotMatch(ligneMorte, /DESIGNATED|▸/, "une chaise morte ne se dit pas désignée");
  assert.doesNotMatch(sortie.stdout, /← DESIGNATED/, "personne n'est désigné au sens du routage");
  assert.match(sortie.stdout, /One chair in service: the mail of "alice" goes to it without a designation\./);
});

// --json/--help AVALAIENT LE MOT SUIVANT (revue adverse, en construisant la carte de
// couverture parseArgs — même classe que la régression de facteur.js,
// backlogée puis reprise ici). Tous les tests et docs existants mettent
// --json en DERNIER (voir ci-dessus) : rien n'avait jamais rendu ce trou
// visible avant. `cc2cc-chaise --json lignees` lit "lignees" comme la
// VALEUR de --json (une chaîne, jamais true) : commande devient undefined,
// et le guichet imprime l'AIDE avec exit 0 — un échec BRUYANT (pas de JSON
// demandé, pas de courrier déplacé), contrairement au démon silencieux de
// facteur.js. C'est pourquoi ce trou est resté BAS plutôt qu'IMPORTANT.
test("--json AVANT la commande ne l'avale plus — --json lignees rend le JSON de lignees, pas l'aide", (t) => {
  const { root } = bureauDePoste(t);
  const sortie = chaise(root, "--json", "lignees");
  assert.equal(sortie.status, 0, sortie.stderr);
  assert.doesNotMatch(sortie.stdout, /^valxos-chaise — who receives/, "avant ce remède, --json lignees imprimait l'AIDE, pas le JSON");
  const contenu = JSON.parse(sortie.stdout);
  assert.ok(Array.isArray(contenu.lignees), "le VRAI JSON de la commande lignees, avec --json avant elle");
});

// ── UNE SEULE SORTIE (Run 6, Task 8, fix round 1) ───────────────────────────
// `terminer()` attendait le drain et RENDAIT la main : le guichet en `if`
// frères tombait alors jusqu'à « Commande inconnue », qui réécrivait l'aide
// sur stderr. Un vrai tube et un lecteur lent forcent le chemin du drain.
function chaiseParUnTube(root, argv) {
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  // `sh` n'a pas PIPESTATUS : le code de sortie du binaire est relu par un
  // fichier, pas deviné par celui de `cat`.
  const rcFichier = path.join(root, "rc-du-binaire");
  const script = `{ ${q(process.execPath)} ${q(path.join(repoRacine, "src/bin/valxos-chaise.js"))} ${argv.map(q).join(" ")}; echo $? > ${q(rcFichier)}; } | (sleep 0.3; cat)`;
  const sortie = spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root },
    maxBuffer: 16 * 1024 * 1024
  });
  return { ...sortie, rc: Number(fs.readFileSync(rcFichier, "utf8").trim()) };
}

test("valxos-chaise aide par un tube lent : rc 0, stderr vide, l'aide une seule fois", () => {
  const root = maisonJetable();
  poserLeBureau(root);
  const sortie = chaiseParUnTube(root, ["aide"]);
  assert.equal(sortie.rc, 0);
  assert.equal(sortie.stderr, "", "aucune « Commande inconnue » après l'aide");
  assert.equal(sortie.stdout.split("valxos-chaise — who receives").length - 1, 1, "l'aide une seule fois");
});

test("valxos-chaise moissonner --json par un tube lent : rc 0, stderr vide, un seul JSON", () => {
  const root = maisonJetable();
  poserLeBureau(root);
  const db = openDatabase({ file: path.join(root, "broker.db") });
  const pidMort = spawnSync(process.execPath, ["-e", ""]).pid;
  // Assez de chaises mortes pour que le JSON dépasse le tampon du tube.
  for (let i = 0; i < 400; i++) {
    registerInstance(db, { lineage: "lignee-moisson", sessionId: `session-morte-${String(i).padStart(4, "0")}`, pid: pidMort });
  }
  db.close();
  const sortie = chaiseParUnTube(root, ["moissonner", "--json"]);
  assert.equal(sortie.rc, 0);
  assert.equal(sortie.stderr, "", "aucune « Commande inconnue » après la moisson");
  const doc = JSON.parse(sortie.stdout);
  assert.equal(doc.moissonnees, 400);
});
