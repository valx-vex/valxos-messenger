// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA GARDE DU BUREAU VIVANT — née ROUGE contre l'incident du 20/08 rejoué.
//
// L'incident : une sonde ad hoc d'un sous-agent a ouvert le broker de PROD
// sans CC2CC_V2_HOME et y a écrit 7 fiches de test. La leçon (discipline des
// gardes, 20/08) : une garde qui ne s'arme que sur le chemin DÉCLARÉ est un
// THÉÂTRE — une sonde intruse ne se déclare jamais. La clôture est donc
// l'ENV DU RUN (CC2CC_GARDE_BUREAU, posé par l'orchestrateur, hérité par tous
// les sous-agents, déclarés ou pas), et la garde va où la donnée SORT :
// l'ouverture en ÉCRITURE du bureau vivant.
// ⚠️ LIMITE CONNUE (v1), dite au GO du 21/08 : elle ne protège que les runs
// qui posent l'env. Fermeture automatique au backlog.
//
// Le « bureau vivant » de ces tests est un FAUX home (HOME=jetable) : on
// rejoue l'incident sans jamais approcher les vrais bureaux de l'opérateur.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { envPropre } from "./aide-env.js";

const repo = path.resolve(new URL("..", import.meta.url).pathname);

function fauxHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-garde-"));
}

// L'incident rejoué : le geste EXACT de la sonde du 20/08 — ouvrir sans home
// explicite, registrer une fiche de test.
//
// Ruling ① (pré-vol, 21/08) : l'ordre de construction de `propre` compte. Le
// jetable `CC2CC_V2_HOME` que le test 3 passe DÉLIBÉRÉMENT dans `env` doit
// survivre — on bâtit donc le socle SANS lui, on le supprime, PUIS on
// applique les overrides de l'appelant par-dessus (Object.assign), et enfin
// on retire les clefs que l'appelant a explicitement mises à `undefined`
// (le geste du test 2 pour lever la garde le temps de poser un bureau sain).
function sondeIntruse(home, env = {}) {
  const propre = { ...envPropre(), HOME: home, CC2CC_GARDE_BUREAU: "1" };
  delete propre.CC2CC_V2_HOME;
  Object.assign(propre, env);
  for (const [clef, valeur] of Object.entries(env)) if (valeur === undefined) delete propre[clef];
  return spawnSync(
    "node",
    ["--input-type=module", "-e",
      `import { openDatabase, registerPeer } from "${repo}/src/lib/database.js";
       const db = openDatabase();
       registerPeer(db, { id: "sonde-intruse" });
       console.log("POLLUE");`],
    { encoding: "utf8", env: propre }
  );
}

test("l'incident du 20/08 rejoué sous garde : l'écriture REFUSE, bruyamment, et rien ne sort", () => {
  const home = fauxHome();
  const sonde = sondeIntruse(home);
  assert.notEqual(sonde.status, 0, "la sonde intruse doit être REFUSÉE — l'incident rejoué ne passe plus");
  assert.match(sonde.stderr, /live office guard/, "le refus se NOMME (jamais un crash muet)");
  assert.match(sonde.stderr, /CC2CC_V2_HOME/, "et il nomme le remède");
  assert.ok(!sonde.stdout.includes("POLLUE"));
  // LA PREUVE QUE LA DONNÉE N'EST PAS SORTIE : aucun bureau créé.
  assert.ok(!fs.existsSync(path.join(home, ".valxos-messenger", "broker.db")), "aucun octet n'a touché le bureau vivant");
  // LE REFUS PRÉCÈDE TOUT EFFET : pas même le mkdir des répertoires — un
  // refus qui laisse le disque déjà touché ne serait qu'un demi-refus.
  assert.ok(
    !fs.existsSync(path.join(home, ".valxos-messenger")),
    "pas même le mkdir — un refus après le disque est un demi-refus"
  );
});

test("mode LECTURE : permis même sous garde — les sondes read-only sont l'outil de travail (note ① de la chaise désignée)", () => {
  const home = fauxHome();
  // Poser d'abord un bureau SANS garde (le geste légitime d'une session de prod).
  const pose = sondeIntruse(home, { CC2CC_GARDE_BUREAU: undefined });
  assert.equal(pose.status, 0, "sans env de garde, RIEN ne change — les sessions de prod ne voient pas la garde");
  const propre = { ...envPropre(), HOME: home, CC2CC_GARDE_BUREAU: "1" };
  delete propre.CC2CC_V2_HOME;
  const lecture = spawnSync(
    "node",
    ["--input-type=module", "-e",
      `import { openDatabase } from "${repo}/src/lib/database.js";
       const db = openDatabase({ readonly: true });
       console.log("LU:" + db.prepare("SELECT count(*) AS n FROM peers").get().n);`],
    { encoding: "utf8", env: propre }
  );
  assert.equal(lecture.status, 0, lecture.stderr);
  assert.match(lecture.stdout, /LU:1/, "la lecture du vrai bureau reste possible sous garde");
});

test("CC2CC_V2_HOME posé : l'écriture passe sous garde — c'est exactement le geste que la garde enseigne", () => {
  const home = fauxHome();
  const jetable = fauxHome();
  const sonde = sondeIntruse(home, { CC2CC_V2_HOME: jetable });
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.match(sonde.stdout, /POLLUE/, "écrire dans une base JETABLE est le chemin béni");
  assert.ok(fs.existsSync(path.join(jetable, "broker.db")), "la donnée est sortie DANS la base jetable");
  assert.ok(!fs.existsSync(path.join(home, ".cc2cc-v2", "broker.db")), "et jamais dans le bureau vivant");
});

// La garde juge la CIBLE, pas la route qui y mène (note du Step 3 du brief).
// `CC2CC_V2_HOME` posé rend le paramètre PAR DÉFAUT de `file` inoffensif —
// mais rien n'empêche un appelant de passer un `file` EXPLICITE qui vise
// quand même le bureau vivant. Un early-return sur la seule PRÉSENCE de
// `CC2CC_V2_HOME` (au lieu de résoudre la cible réelle) resterait vert sur
// les 3 tests au-dessus tout en laissant passer exactement ce détour.
test("un `file` EXPLICITE vers le bureau vivant refuse aussi, même avec CC2CC_V2_HOME posé ailleurs (la cible, pas la route)", () => {
  const home = fauxHome();
  const jetable = fauxHome();
  const propre = { ...envPropre(), HOME: home, CC2CC_GARDE_BUREAU: "1", CC2CC_V2_HOME: jetable };
  const cibleExplicite = path.join(home, ".cc2cc-v2", "broker.db");
  const sonde = spawnSync(
    "node",
    ["--input-type=module", "-e",
      `import { openDatabase, registerPeer } from "${repo}/src/lib/database.js";
       const db = openDatabase({ file: ${JSON.stringify(cibleExplicite)} });
       registerPeer(db, { id: "sonde-route-explicite" });
       console.log("POLLUE");`],
    { encoding: "utf8", env: propre }
  );
  assert.notEqual(sonde.status, 0, "un file explicite vers le bureau vivant refuse, malgré CC2CC_V2_HOME posé ailleurs");
  assert.match(sonde.stderr, /live office guard/, "le refus se NOMME");
  assert.ok(!sonde.stdout.includes("POLLUE"));
  assert.ok(!fs.existsSync(cibleExplicite), "aucun octet n'a touché le bureau vivant, malgré la route détournée");
});

// LE VERROU DU FACTEUR NE NAÎT PAS SUR UN BUREAU REFUSÉ (fix-wave du 21/08).
// `prendreLeVerrou` écrit `run/facteur.verrou` en fs BRUT : la garde ne le voit
// pas, elle ne juge que l'ouverture du broker. Tant que le verrou se posait
// AVANT l'ouverture, un démon visant le vrai bureau sous garde y laissait son
// verrou puis se faisait refuser la base — rouge mesuré avant le remède :
// status 1, refus nommé, ET `run/facteur.verrou` présent, run/ créé. Le remède
// n'est pas une garde de plus : c'est l'ORDRE (le bureau d'abord), donc ce test
// est aussi le contrôle que l'ordre ne se ré-inverse pas.
test("le démon sous garde : refusé AVANT de poser son verrou — aucun verrou orphelin sur le bureau refusé", () => {
  const home = fauxHome();
  const propre = { ...envPropre(), HOME: home, CC2CC_GARDE_BUREAU: "1" };
  delete propre.CC2CC_V2_HOME;
  const demon = spawnSync(
    "node",
    ["--input-type=module", "-e",
      `import { demarrerLeFacteur } from "${repo}/src/facteur/daemon.js";
       await demarrerLeFacteur({ tours: 1, journal: () => {}, attendre: async () => {}, faireLaTournee: async () => ({}) });
       console.log("PARTI");`],
    { encoding: "utf8", env: propre }
  );
  assert.notEqual(demon.status, 0, "un démon qui vise le bureau vivant sous garde ne part pas");
  assert.match(demon.stderr, /live office guard/, "et le refus se NOMME");
  assert.ok(!demon.stdout.includes("PARTI"));
  assert.ok(
    !fs.existsSync(path.join(home, ".valxos-messenger", "run", "facteur.verrou")),
    "aucun verrou orphelin : le bureau s'ouvre AVANT que le verrou ne naisse"
  );
  assert.ok(!fs.existsSync(path.join(home, ".valxos-messenger")), "pas même le mkdir — un refus après le disque est un demi-refus");
});

// ── LE LIEN SYMBOLIQUE (revue adverse F1, 21/08 — contournement EXÉCUTÉ) ───
// La garde comparait des CHAÎNES. Un `file` qui ne ressemble en rien au bureau
// vivant, et que SQLite suit jusqu'au vrai broker, passait : mesuré avant le
// remède, 122 880 octets écrits dans le bureau, garde muette, `POLLUE` en
// sortie. La garde résout maintenant la cible RÉELLE des deux côtés.
//
// Trois routes, trois tests, plus un contrôle positif : une garde qui refuserait
// tout lien ne serait plus une garde, ce serait un mur.
function lienVers(cible, nom = "innocent.db") {
  const ailleurs = fauxHome();
  const lien = path.join(ailleurs, nom);
  fs.symlinkSync(cible, lien);
  return lien;
}

function ouvrirEtEcrire(home, file, { id = "sonde-par-lien" } = {}) {
  const propre = { ...envPropre(), HOME: home, CC2CC_GARDE_BUREAU: "1" };
  delete propre.CC2CC_V2_HOME;
  return spawnSync(
    "node",
    ["--input-type=module", "-e",
      `import { openDatabase, registerPeer } from "${repo}/src/lib/database.js";
       const db = openDatabase({ file: ${JSON.stringify(file)} });
       registerPeer(db, { id: ${JSON.stringify(id)} });
       console.log("POLLUE");`],
    { encoding: "utf8", env: propre }
  );
}

test("un LIEN SYMBOLIQUE vers le bureau vivant ne contourne plus la garde — la cible réelle, pas le chemin écrit", () => {
  const home = fauxHome();
  // Le bureau existe déjà (une session de prod l'a posé), le broker pas encore :
  // le lien est PENDANT, et `realpath` seul ne le résoudrait pas — alors que
  // SQLite, lui, créerait le fichier AU BOUT.
  fs.mkdirSync(path.join(home, ".cc2cc-v2"), { recursive: true });
  const vrai = path.join(home, ".cc2cc-v2", "broker.db");
  const sonde = ouvrirEtEcrire(home, lienVers(vrai));
  assert.notEqual(sonde.status, 0, "le lien pendant vers le broker refuse");
  assert.match(sonde.stderr, /live office guard/, "le refus se NOMME");
  assert.ok(!sonde.stdout.includes("POLLUE"));
  assert.ok(!fs.existsSync(vrai), "et pas un octet au bout du lien");
});

test("le lien dont la cible EXISTE DÉJÀ refuse aussi : le bureau posé ne se ré-ouvre pas par la bande", () => {
  const home = fauxHome();
  // Poser un vrai bureau SANS garde, comme une session de prod le ferait.
  const vrai = path.join(home, ".cc2cc-v2", "broker.db");
  assert.equal(
    sondeIntruse(home, { CC2CC_GARDE_BUREAU: undefined, CC2CC_V2_HOME: path.dirname(vrai) }).status,
    0
  );
  const avant = fs.statSync(vrai).size;
  const sonde = ouvrirEtEcrire(home, lienVers(vrai), { id: "sonde-lien-existant" });
  assert.notEqual(sonde.status, 0, "un lien vers un broker EXISTANT refuse");
  assert.match(sonde.stderr, /live office guard/);
  assert.ok(!sonde.stdout.includes("POLLUE"));
  assert.equal(fs.statSync(vrai).size, avant, "le bureau posé n'a pas grossi d'un octet");
});

test("un lien de RÉPERTOIRE au milieu de la route refuse : la remontée résout les ancêtres aussi", () => {
  const home = fauxHome();
  fs.mkdirSync(path.join(home, ".cc2cc-v2"), { recursive: true });
  // Le lien vise le RÉPERTOIRE du bureau ; le fichier demandé n'existe pas
  // encore, et son plus profond ancêtre existant EST le lien.
  const lienDossier = lienVers(path.join(home, ".cc2cc-v2"), "dossier-innocent");
  const sonde = ouvrirEtEcrire(home, path.join(lienDossier, "broker.db"), { id: "sonde-lien-dossier" });
  assert.notEqual(sonde.status, 0, "la route passe par un lien de répertoire : refusée quand même");
  assert.match(sonde.stderr, /live office guard/);
  assert.ok(!fs.existsSync(path.join(home, ".cc2cc-v2", "broker.db")), "rien au bout");
});

// LE LIEN DE RÉPERTOIRE PENDANT — L'INSTALLATION FRAÎCHE (re-review du 21/08).
// Les trois tests au-dessus posent tous un bureau qui EXISTE, ou un lien dont
// seule la FEUILLE pend. Le cas qui restait ouvert : le lien vise le
// RÉPERTOIRE du bureau, et le bureau n'existe pas encore — le premier
// lancement sur une machine neuve. La remontée d'alors ne re-testait pas ses
// ancêtres comme des liens : elle enjambait la porte pendante, concluait
// « ailleurs », et `ensureRuntimeDirs` dé-pendait le lien en créant le bureau
// AU BOUT. Mesuré : 122 880 octets, bureau créé, garde muette.
test("un lien de RÉPERTOIRE PENDANT vers un bureau qui n'existe PAS ENCORE refuse — le cas de l'installation fraîche", () => {
  const home = fauxHome();
  const ailleurs = fauxHome();
  const porte = path.join(ailleurs, "porte");
  fs.symlinkSync(path.join(home, ".cc2cc-v2"), porte);
  assert.ok(!fs.existsSync(path.join(home, ".cc2cc-v2")), "le décor EXIGE un bureau absent — sinon ce test ne prouve rien");

  const sonde = ouvrirEtEcrire(home, path.join(porte, "broker.db"), { id: "sonde-porte-pendante" });
  assert.notEqual(sonde.status, 0, "la porte pendante refuse");
  assert.match(sonde.stderr, /live office guard/, "le refus se NOMME");
  assert.ok(!sonde.stdout.includes("POLLUE"));
  assert.ok(!fs.existsSync(path.join(home, ".cc2cc-v2")), "et le bureau n'a pas été créé AU BOUT du lien");
});

test("contrôle positif : un lien vers une base JETABLE passe — la garde reste une garde, pas un mur", () => {
  const home = fauxHome();
  const jetable = fauxHome();
  const sonde = ouvrirEtEcrire(home, lienVers(path.join(jetable, "broker.db"), "jetable.db"), { id: "sonde-lien-jetable" });
  assert.equal(sonde.status, 0, sonde.stderr);
  assert.match(sonde.stdout, /POLLUE/, "écrire par un lien vers une base jetable n'a jamais rien eu d'illégitime");
  assert.ok(fs.existsSync(path.join(jetable, "broker.db")), "la donnée est sortie DANS la base jetable");
  assert.ok(!fs.existsSync(path.join(home, ".cc2cc-v2", "broker.db")), "et AUCUN broker au bureau vivant");

  // ⚠️ CE QUE CE CONTRÔLE ÉPINGLE EST UN TROU, PAS UNE SANTÉ. La garde juge
  // l'ouverture du broker ; `writeHeartbeat` et `ensureRuntimeDirs`, eux,
  // suivent l'ENV (`baseDir()`) et pas le `file` qu'on vient de leur imposer.
  // Une ouverture parfaitement légitime vers une base jetable stampe donc
  // ENCORE une fiche sur le bureau vivant quand `CC2CC_V2_HOME` n'est pas
  // posé — c'est exactement le résidu que le commentaire de la garde nomme
  // (database.js), et la raison pour laquelle chaque fichier de test pose
  // l'env (revue adverse F2). Le jour où ce résidu se ferme, cette assertion tombera :
  // c'est voulu — qu'elle se retourne alors en « rien au bureau ».
  assert.ok(
    fs.existsSync(path.join(home, ".valxos-messenger", "status", "sonde-lien-jetable.json")),
    "résidu connu (backlog v2) : la fiche suit l'ENV, pas le fichier — la garde ne couvre que le broker"
  );
});

// ── LE BALAYAGE : AUCUN TEST NE SALIT LE BUREAU VIVANT (revue adverse F2, 21/08) ─
// L'incident du 20/08 était une sonde ad hoc ; celui-ci vient de la SUITE
// elle-même. Deux fichiers de test écrivaient des fiches dans le VRAI bureau
// (`~/.cc2cc-v2/status/morte-en-dette.json`, `vivante-sans-dette.json`,
// constatées, mtime = la dernière exécution), et huit autres y créaient les
// répertoires du bureau : un `file` explicite ne protège rien, parce que
// `ensureRuntimeDirs`, `writeHeartbeat` et le registre lisent `baseDir()` —
// l'ENV, jamais le fichier.
//
// Le remède par fichier (un plancher jetable posé avant le premier test) se
// re-perdra le jour où quelqu'un écrira un fichier de test de plus. Cette garde
// ne vérifie donc PAS que les fichiers DISENT la bonne chose — un oracle de
// déclaration est un théâtre : elle REJOUE toute la suite sous un faux HOME et
// regarde si un bureau apparaît. Un chemin, pas un point.
//
// Ce que ça coûte : ~10 s, la suite tourne deux fois. Ce que ça achète : le
// jour où un test neuf salit le bureau, c'est ROUGE ici, pas dans le
// du bureau de l'opérateur.
//
// La SEULE exclusion est ce fichier-ci — sinon le balayage se rejouerait
// lui-même sans fin. Elle est nommée, et c'est la seule : un instrument doit
// pouvoir voir tout ce qu'on ne lui demande pas d'exclure.
test("aucun fichier de la suite n'écrit dans le bureau vivant — la suite rejouée sous un faux HOME", { timeout: 180_000 }, () => {
  const home = fauxHome();
  const fichiers = fs
    .readdirSync(path.join(repo, "test"))
    .filter((f) => f.endsWith(".test.js") && f !== "garde-bureau.test.js")
    .map((f) => path.join(repo, "test", f));
  assert.ok(fichiers.length >= 15, `le balayage doit voir la suite entière, pas ${fichiers.length} fichiers`);

  const propre = { ...envPropre(), HOME: home };
  delete propre.CC2CC_V2_HOME;
  // LE BUREAU DU LANCEUR, REJOUÉ : un lanceur qui exporte VALXOS_MESSENGER_HOME
  // pour lui-même ne doit envoyer AUCUN test dans son bureau — ni par un
  // enfant qu'un test lance (envPropre), ni en-processus (un test qui pose
  // `process.env.CC2CC_V2_HOME` perd contre la clef neuve héritée : mesuré le
  // 29/08, 36 fichiers créaient le bureau exporté et y posaient leurs fiches).
  // Ce bureau-ci n'existe pas ; s'il apparaît, un test l'a hérité.
  const bureauDuLanceur = path.join(fauxHome(), "bureau-du-lanceur");
  propre.VALXOS_MESSENGER_HOME = bureauDuLanceur;
  // La garde est LEVÉE dans l'enfant, délibérément : on veut voir la fuite
  // telle qu'elle serait, pas une garde qui la masque. Un balayage qui refuse
  // les écritures ne prouve rien sur la propreté des tests.
  delete propre.CC2CC_GARDE_BUREAU;
  // ⚠️ CETTE LIGNE EST LA GARDE DE LA GARDE. `node --test` pose
  // NODE_TEST_CONTEXT dans ses enfants ; hérité, le runner imbriqué répond
  // « run() is being called recursively — skipping running files », n'exécute
  // RIEN, et sort avec 0. Ce balayage a été VERT en 58 ms dans cet état :
  // zéro test joué, bureau propre par construction, théâtre parfait.
  delete propre.NODE_TEST_CONTEXT;
  // ⚠️ UNE BORNE SUR L'ENFANT, PAS SEULEMENT SUR LE TEST (Run 6, 27/09).
  // `spawnSync` bloque la boucle d'événements : le `timeout` du test ne peut
  // JAMAIS tirer pendant qu'il attend. Mesuré : un fichier rejoué qui pendait
  // a tenu celui-ci 897 s, jusqu'au plafond de la suite. L'enfant est borné
  // ici, sous le timeout du test, et une borne atteinte est nommée.
  const balayage = spawnSync("node", ["--test", "--test-reporter=tap", ...fichiers], {
    encoding: "utf8",
    cwd: repo,
    env: propre,
    timeout: 170_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024
  });
  assert.ok(!balayage.error, `SONDE IMPOSSIBLE : le balayage n'a pas fini (${balayage.error?.code || balayage.error?.message}, signal ${balayage.signal})`);
  const sortie = `${balayage.stdout || ""}\n${balayage.stderr || ""}`;
  const chiffre = (clef) => Number(new RegExp(`^# ${clef} (\\d+)$`, "m").exec(balayage.stdout || "")?.[1] ?? NaN);

  // TROIS ISSUES, JAMAIS DEUX : conforme · incohérence · sonde impossible. Un
  // balayage qui n'a pas pu tourner ne sera JAMAIS lu comme un bureau propre —
  // il DOIT prouver qu'il a touché sa cible avant que son verdict compte.
  assert.ok(!/skipping running files/.test(sortie), "SONDE IMPOSSIBLE : le runner imbriqué n'a exécuté aucun fichier");
  const joues = chiffre("tests");
  assert.ok(
    Number.isFinite(joues) && joues >= 300,
    `SONDE IMPOSSIBLE : ${joues} tests joués par le balayage — un plancher, pas un compte : son seul rôle est de refuser le « rien joué ».`
  );
  assert.equal(chiffre("fail"), 0, `SONDE IMPOSSIBLE : la suite rejouée n'est pas verte.\n${(balayage.stdout || "").slice(-2000)}`);
  assert.equal(balayage.status, 0, "SONDE IMPOSSIBLE : le balayage sort en erreur");

  // Et seulement MAINTENANT, le verdict.
  assert.ok(
    !fs.existsSync(bureauDuLanceur),
    `un fichier de test a hérité le bureau exporté par le lanceur : ${
      fs.existsSync(bureauDuLanceur) ? execFileSync("find", [bureauDuLanceur], { encoding: "utf8" }).trim().split("\n").length : 0
    } entrée(s) créée(s) — pose ton bureau avec poserLeBureau() (test/aide-env.js), jamais par process.env.CC2CC_V2_HOME seul`
  );
  for (const nom of [".valxos-messenger", ".cc2cc-v2"]) {
    const bureau = path.join(home, nom);
    assert.ok(
      !fs.existsSync(bureau),
      `un fichier de test a touché le bureau vivant ${nom} : ${
        fs.existsSync(bureau) ? fs.readdirSync(bureau).join(", ") : ""
      } — pose un plancher jetable (VALXOS_MESSENGER_HOME ou CC2CC_V2_HOME) avant le premier test de ce fichier`
    );
  }
});
