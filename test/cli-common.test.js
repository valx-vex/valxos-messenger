// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// UN DRAPEAU SANS VALEUR REFUSE PROPREMENT, IL NE PLANTE PLUS (remède de la revue adverse #3,
// C7). `parseArgs` rend `true` pour un drapeau donné sans valeur (le dernier
// de la ligne, ou suivi d'un autre drapeau) — EXACTEMENT la même forme qu'un
// booléen voulu (--json, --help). Sans garde, ce `true` traversait jusqu'à
// SQLite et sortait en stacktrace («SQLite3 can only bind numbers, strings,
// bigints, buffers, and null») plutôt qu'en refus nommé, exit 2. Preuve
// reproduite AVANT ce remède : `cc2cc-send --to X --body Y --msg-id` (dernier
// drapeau sans valeur) plantait ainsi ; même chose pour --to.
// ⚠️ Bases JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant n'ouvre jamais.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { insertMessage, openDatabase } from "../src/lib/database.js";
import { parseArgs } from "../src/bin/cli-common.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

// ⚠️ LE JETABLE VAUT AUSSI POUR CE PROCESSUS-CI (revue adverse F2, 21/08). Un `file`
// explicite ne protège PAS le bureau vivant : `ensureRuntimeDirs`,
// `writeHeartbeat` et le registre lisent `baseDir()` — donc l'ENV du runner,
// jamais le fichier qu'on vient de leur imposer. Sans ce plancher, les gestes
// EN PROCESSUS de ce fichier écrivaient dans le VRAI ~/.cc2cc-v2 (fiches et
// répertoires constatés le 21/08). Les tests qui posent leur propre racine la
// posent par-dessus ; l'état d'origine se restaure à la fin du fichier.
const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-cli-common-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});


const repo = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-cli-common-"));
}

function lancer(script, args) {
  const root = maisonJetable();
  return spawnSync(process.execPath, [path.join(repo, script), ...args], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "posteur-cli-common" }
  });
}

test("cc2cc-send --msg-id sans valeur refuse proprement (exit 2), ne plante plus", () => {
  const resultat = lancer("src/bin/valxos-send.js", ["--to", "alpha", "--body", "hello", "--msg-id"]);
  assert.equal(resultat.status, 2, "un refus nommé, jamais un crash Node (status null/1 + stacktrace)");
  assert.doesNotMatch(resultat.stderr, /TypeError|SQLite3 can only bind/, "plus de stacktrace SQLite");
  assert.match(resultat.stderr, /--msg-id/, "le refus NOMME le drapeau en cause");
});

test("cc2cc-send --to sans valeur refuse proprement (exit 2), ne plante plus", () => {
  const resultat = lancer("src/bin/valxos-send.js", ["--body", "hello", "--to"]);
  assert.equal(resultat.status, 2);
  assert.doesNotMatch(resultat.stderr, /TypeError|SQLite3 can only bind/);
  assert.match(resultat.stderr, /--to/);
});

test("cc2cc-send --body sans valeur refuse proprement (exit 2) — même défaut, même famille", () => {
  const resultat = lancer("src/bin/valxos-send.js", ["--to", "alpha", "--body"]);
  assert.equal(resultat.status, 2);
  assert.doesNotMatch(resultat.stderr, /TypeError|SQLite3 can only bind/);
  assert.match(resultat.stderr, /--body/);
});

test("cc2cc-inbox --limit sans valeur refuse proprement — avant ce remède, silencieux et FAUX (limit=1)", () => {
  const resultat = lancer("src/bin/valxos-inbox.js", ["--self", "posteur-cli-common", "--limit"]);
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--limit/);
});

test("le chemin sain n'est pas touché : tous les drapeaux avec leur valeur, ça marche toujours", () => {
  const resultat = lancer("src/bin/valxos-send.js", [
    "--to", "alpha", "--body", "un vrai message", "--msg-id", "cli-c7-1",
    "--subject", "objet", "--thread-id", "fil-1", "--priority", "high"
  ]);
  assert.equal(resultat.status, 0, `devrait réussir : ${resultat.stderr}`);
  const contenu = JSON.parse(resultat.stdout);
  assert.equal(contenu.sent, true);
  assert.equal(contenu.msg_id, "cli-c7-1");
});

// "--clé=valeur" CONTOURNAIT TOUTE GARDE À VALEUR (review interne, dernière
// vague — pas un trou d'identité : la review a vérifié que chaque
// orthographe rend la boîte du POSTEUR, jamais celle visée). `parseArgs` ne
// reconnaît que "--clé valeur" (espace-séparé) : "--from=alice" devient une
// clé LITTÉRALE "from=alice" qui ne matche jamais `args.from` — le refus
// nommé que valxos-inbox.js pose sur --from (MINEUR 7, plus haut dans ce
// remède) ne se déclenchait donc JAMAIS pour cette orthographe, et la
// commande retombait silencieusement sur SA PROPRE boîte : un succès qui a
// l'air bon et ne l'est pas, exactement ce que ce remède existe pour fermer.
// Le refus vit maintenant dans parseArgs LUI-MÊME, avant toute ouverture de
// base — partagé par CHAQUE CLI, pas recopié par script.
test("cc2cc-inbox --from=alice (syntaxe =) est refusé — ne se glisse plus derrière l'orthographe --from alice, et n'ouvre toujours aucune boîte", () => {
  const root = maisonJetable();
  const db = openDatabase({ file: path.join(root, "broker.db") });
  insertMessage(db, { msg_id: "L-secret-egal", sender: "a", recipient: "alice", body: "SECRET-VIA-FROM-EGAL" });
  db.close();

  const resultat = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-inbox.js"), "--from=alice"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: root, CC2CC_SELF: "bob-cli-common" }
  });

  assert.equal(resultat.status, 2, "un refus nommé, plus un succès silencieux sur la mauvaise boîte");
  assert.match(resultat.stderr, /--from/, "le refus NOMME le drapeau, comme pour --from sans =");
  assert.equal(resultat.stdout, "", "aucune boîte n'est rendue, ni celle d'alice ni celle du posteur");

  const lecture = openDatabase({ file: path.join(root, "broker.db"), readonly: true });
  const lettre = lecture.prepare("SELECT delivered_at FROM messages WHERE msg_id = 'L-secret-egal'").get();
  lecture.close();
  assert.equal(lettre.delivered_at, null, "aucun effet de bord — le refus arrive avant toute ouverture de boîte");
});

test("cc2cc-inbox --self=alice (syntaxe =) est refusé de la même façon", () => {
  const resultat = spawnSync(process.execPath, [path.join(repo, "src/bin/valxos-inbox.js"), "--self=alice"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: maisonJetable(), CC2CC_SELF: "bob-cli-common" }
  });
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--self/);
  assert.equal(resultat.stdout, "");
});

// --subject (jamais requireArg, seulement optionalArg) : sans lui, un
// --to=alpha aurait aussi fini en exit 2, mais par la garde PRÉEXISTANTE
// "Missing required --to" (requireArg), coïncidence qui rendrait ce test
// vert même sans ce remède. --subject n'a AUCUNE garde aujourd'hui — avant
// le remède, "--subject=objet" est silencieusement ignoré et l'envoi
// RÉUSSIT (exit 0, sans objet) ; c'est cette ambiguïté-là que ce test isole.
test("--subject=objet (syntaxe =) est refusé aussi côté cc2cc-send — le refus vit dans parseArgs, partagé par tous les CLI, pas une coïncidence d'un requireArg voisin", () => {
  const resultat = lancer("src/bin/valxos-send.js", ["--to", "alpha", "--body", "x", "--subject=objet"]);
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--subject/);
});

test("une VALEUR contenant '=' n'est pas confondue avec un drapeau '=' — seul le TOKEN du drapeau est jugé", () => {
  const resultat = lancer("src/bin/valxos-send.js", [
    "--to", "alpha", "--body", "a=b et c=d, du texte normal", "--msg-id", "cli-egal-sain-1"
  ]);
  assert.equal(resultat.status, 0, `un '=' dans une VALEUR ne doit rien refuser : ${resultat.stderr}`);
  const contenu = JSON.parse(resultat.stdout);
  assert.equal(contenu.sent, true);
});

// UN DRAPEAU BOOLÉEN AVALAIT LE MOT SUIVANT COMME VALEUR (review interne,
// vague suivante — RÉGRESSION introduite par un remède antérieur de facteur.js).
// `parseArgs` consomme le token suivant dès qu'il ne commence pas par "--" —
// correct pour un drapeau à VALEUR (--to alpha), FAUX pour un drapeau
// purement booléen (--une-tournee, --silencieux) : `facteur --une-tournee
// BAREWORD` rendait `args.une_tournee = "BAREWORD"` (une chaîne), le test
// `=== true` de facteur.js échouait, et la ligne de commande basculait dans
// le démon SANS BORNE au lieu du one-shot demandé — preuve reproduite,
// process tué par un garde-fou de 5 s, jamais rendu la main. `booleans`
// déclare les drapeaux qui ne consomment JAMAIS le mot suivant, quel qu'il
// soit — le contraire de `refuserSiValeurManquante` (qui refuse un --to sans
// valeur) : ici on refuse à un drapeau booléen le DROIT de lire une valeur.
test("parseArgs({booleans}) : un drapeau déclaré booléen n'avale JAMAIS le mot suivant comme valeur", () => {
  const args = parseArgs(["--une-tournee", "BAREWORD"], { booleans: ["une_tournee"] });
  assert.equal(args.une_tournee, true, "toujours true, jamais le mot qui suit");
  assert.deepEqual(args._, ["BAREWORD"], "le mot suivant reste positionnel — exactement ce que l'ancienne boucle exacte de facteur.js faisait déjà");
});

test("parseArgs SANS la déclaration booleans garde l'ancien comportement — rétrocompatible pour tous les autres appelants", () => {
  const args = parseArgs(["--to", "alpha", "--msg-id"]);
  assert.equal(args.to, "alpha", "un drapeau non déclaré booléen continue de consommer sa valeur");
  assert.equal(args.msg_id, true, "et sans valeur suivante, true comme avant — comportement inchangé pour cc2cc-send/inbox/chaise/unregister");
});

test("un drapeau booléen déclaré, donné SANS rien après, reste true — le cas le plus courant n'est pas touché", () => {
  const args = parseArgs(["--une-tournee"], { booleans: ["une_tournee"] });
  assert.equal(args.une_tournee, true);
  assert.deepEqual(args._, []);
});

// valxos-peers.js AVAIT LE MÊME TROU que facteur.js, PAR UNE AUTRE PORTE
// (review interne, vague suivante — corrige ma propre phrase « le seul des
// sept » d'un commit antérieur, qui était fausse) : `args.includes("--all")` sur
// l'argv BRUT, jamais parseArgs. "--all=true" ne matche jamais la chaîne
// EXACTE "--all", donc includeDead restait false et l'outil rendait
// silencieusement la vue par défaut (receveurs seulement, aucune chaise
// morte) avec exit 0 — aucun refus, un résultat qui a l'air bon (JSON
// valide) et ne l'est pas.
test("cc2cc-peers --all=true (syntaxe =) est refusé — avant ce remède, silencieux et FAUX (rendait la vue par défaut, exit 0)", () => {
  const resultat = lancer("src/bin/valxos-peers.js", ["--all=true"]);
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--all/);
});

test("cc2cc-peers --include-dead=1 (syntaxe =) est refusé de la même façon", () => {
  const resultat = lancer("src/bin/valxos-peers.js", ["--include-dead=1"]);
  assert.equal(resultat.status, 2);
  assert.match(resultat.stderr, /--include-dead/);
});

// La revue adverse, en construisant la carte de couverture parseArgs : le refus "="
// conseillait "use --silencieux VALUE (space-separated)" pour un drapeau
// déclaré BOOLÉEN — un conseil qui ne s'applique jamais à lui, puisqu'il ne
// prend jamais de valeur du tout. Cosmétique, hérité du premier remède "=",
// écrit avant que `booleans` existe.
test("le refus = conseille juste pour un drapeau BOOLÉEN — pas « use --silencieux VALUE », un drapeau qui n'en prend jamais", () => {
  const resultat = spawnSync(process.execPath, [path.join(repo, "src/bin/facteur.js"), "--une-tournee", "--silencieux=x"], {
    encoding: "utf8",
    env: { ...envPropre(), CC2CC_V2_HOME: maisonJetable() }
  });
  assert.equal(resultat.status, 2);
  assert.doesNotMatch(resultat.stderr, /VALUE \(space-separated\)/, "un booléen ne prend JAMAIS de valeur — ce conseil ne s'applique pas à lui");
  assert.match(resultat.stderr, /--silencieux/, "le refus continue de NOMMER le drapeau");
});
