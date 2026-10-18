// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// ⑩ `web.env` EST LU EN ENTIER — pas seulement le jeton.
//
// Le fichier est le seul endroit prévu pour régler la porte, et le lanceur n'y
// lisait QUE `CC2CC_WEB_JETON` : l'hôte et le port venaient de l'ENV du shell
// et de nulle part ailleurs. Sonde du 22/08 : un `web.env` portant
// `CC2CC_WEB_PORT=9911` → le lanceur annonçait toujours 8790. Un opérateur qui
// change le port dans le fichier PRÉVU pour ça voyait la porte l'ignorer, sans
// un mot. Le silence est le vrai défaut : ou le fichier gouverne, ou il ne
// déclare pas ces clefs.
//
// L'ORDRE, lui, ne change pas — c'est celui du jeton, et pour la même raison :
// l'ENV d'abord (le geste d'opérateur délibéré, celui qui permet de lancer une
// deuxième porte sans toucher au fichier), le fichier ensuite, le défaut en
// dernier.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-config-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { HOTE_PAR_DEFAUT, PORT_PAR_DEFAUT, configDeLaPorte, reglagesDeLaPorte } from "../src/web/auth.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const racine = path.resolve(new URL("..", import.meta.url).pathname);

function maisonJetable(t, contenu = null) {
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-config-"));
  t.after(() => fs.rmSync(maison, { recursive: true, force: true }));
  if (contenu !== null) fs.writeFileSync(path.join(maison, "web.env"), contenu, { mode: 0o600 });
  return { maison, fichier: path.join(maison, "web.env") };
}

test("⑩ la configuration se lit dans web.env — hôte et port compris, et l'ENV garde le dernier mot", (t) => {
  const jeton = "d".repeat(64);

  // ① LE FICHIER SEUL GOUVERNE.
  const { fichier } = maisonJetable(
    t,
    `CC2CC_WEB_JETON=${jeton}\nCC2CC_WEB_HOTE=::1\nCC2CC_WEB_PORT=9911\nCC2CC_WEB_OPERATEUR=alice\n`
  );
  const duFichier = configDeLaPorte({ fichier, env: {} });
  assert.equal(duFichier.jeton, jeton);
  assert.equal(duFichier.hote, "::1", "l'hôte du fichier est HONORÉ — sinon la clef est un mensonge");
  assert.equal(duFichier.port, 9911, "le port du fichier est HONORÉ (sonde du 22/08 : la porte annonçait 8790)");
  assert.equal(duFichier.operateur, "alice", "le nom unique de la porte vient du même fichier que le jeton");

  // ② L'ENV L'EMPORTE — c'est ce qui permet d'ouvrir une deuxième porte sans
  //    toucher au fichier, et c'est déjà l'ordre du jeton.
  const deLEnv = configDeLaPorte({
    fichier,
    env: {
      CC2CC_WEB_HOTE: "127.0.0.1",
      VALXOS_WEB_HOTE: "::1",
      CC2CC_WEB_PORT: "8123",
      VALXOS_WEB_PORT: "8124",
      CC2CC_WEB_JETON: "e".repeat(64),
      VALXOS_WEB_JETON: "f".repeat(64),
      CC2CC_WEB_OPERATEUR: "ancienne-clef",
      VALXOS_WEB_OPERATEUR: "nouvelle-clef"
    }
  });
  assert.equal(deLEnv.hote, "::1");
  assert.equal(deLEnv.port, 8124);
  assert.equal(deLEnv.jeton, "f".repeat(64));
  assert.equal(deLEnv.operateur, "nouvelle-clef", "VALXOS_* l'emporte quand les deux familles sont posées");

  // ③ NI L'UN NI L'AUTRE : les défauts, et ils sont nommés une seule fois.
  const { fichier: nu } = maisonJetable(t, `CC2CC_WEB_JETON=${jeton}\nCC2CC_WEB_OPERATEUR=alice\n`);
  const parDefaut = configDeLaPorte({ fichier: nu, env: {} });
  assert.equal(parDefaut.hote, HOTE_PAR_DEFAUT);
  assert.equal(parDefaut.port, PORT_PAR_DEFAUT);
  assert.equal(PORT_PAR_DEFAUT, 8790, "le port du contrat");
  assert.equal(HOTE_PAR_DEFAUT, "127.0.0.1", "la boucle locale, et rien d'autre");

  // ④ UN PORT ILLISIBLE NE DEVIENT PAS ZÉRO EN SILENCE. `Number("neuf")` rend
  //    NaN, et `listen(NaN)` prend un port au hasard : la porte s'ouvrirait
  //    quelque part, et le marque-page ne la trouverait plus.
  const { fichier: casse } = maisonJetable(
    t,
    `CC2CC_WEB_JETON=${jeton}\nCC2CC_WEB_PORT=neuf-mille\nCC2CC_WEB_OPERATEUR=alice\n`
  );
  assert.throws(
    () => configDeLaPorte({ fichier: casse, env: {} }),
    /port/i,
    "un port illisible se REFUSE en le nommant, il ne se devine pas"
  );

  // ⑤ LIRE LES RÉGLAGES N'ÉCRIT RIEN. C'est ce qui permet au lanceur de
  //    vérifier l'hôte AVANT que le moindre octet ne touche le disque — un
  //    refus qui laisse le disque déjà touché n'est qu'un demi-refus
  //    (un correctif antérieur). `chargerLeJeton`, lui, POSE un fichier.
  const vierge = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-vierge-"));
  t.after(() => fs.rmSync(vierge, { recursive: true, force: true }));
  const absent = path.join(vierge, "web.env");
  const reglages = reglagesDeLaPorte({ fichier: absent, env: { VALXOS_WEB_OPERATEUR: "alice" } });
  assert.equal(reglages.port, PORT_PAR_DEFAUT);
  assert.ok(!fs.existsSync(absent), "lire les réglages ne doit RIEN poser sur le disque");
});

test("① sans nom d'opérateur configuré, la porte refuse de démarrer avant tout effet disque", (t) => {
  const { maison, fichier } = maisonJetable(t, null);
  assert.throws(
    () => reglagesDeLaPorte({ fichier, env: {} }),
    /VALXOS_WEB_OPERATEUR|CC2CC_WEB_OPERATEUR/,
    "aucun nom anonyme ou personnel ne doit naître par défaut"
  );

  const env = { ...envPropre(), CC2CC_V2_HOME: maison };
  for (const clef of [
    "VALXOS_WEB_OPERATEUR",
    "CC2CC_WEB_OPERATEUR",
    "VALXOS_WEB_JETON",
    "CC2CC_WEB_JETON"
  ]) delete env[clef];
  const lancement = spawnSync("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    encoding: "utf8",
    env,
    timeout: 2_000,
    killSignal: "SIGKILL"
  });
  assert.equal(lancement.signal, null, "le refus doit être immédiat, jamais un serveur tué par le couperet");
  assert.equal(lancement.status, 2, lancement.stderr);
  assert.match(lancement.stderr, /without an operator name: set VALXOS_WEB_OPERATEUR \(or its alias CC2CC_WEB_OPERATEUR\)/);
  assert.ok(!lancement.stdout.includes("PORTE"));
  assert.ok(!fs.existsSync(fichier), "le refus précède même la création de web.env");
  assert.ok(!fs.existsSync(path.join(maison, "broker.db")), "le refus précède l'ouverture du bureau");
});

// ── LE LANCEUR, POUR DE VRAI ────────────────────────────────────────────────
// La fonction pure ne prouve que la fonction pure. Ce qui compte, c'est que le
// LANCEUR la traverse — un remède posé à côté du chemin réel n'est pas un
// remède.

function portLibre() {
  return new Promise((resolve) => {
    const guichet = net.createServer();
    guichet.listen(0, "127.0.0.1", () => {
      const { port } = guichet.address();
      guichet.close(() => resolve(port));
    });
  });
}

test("⑩ le LANCEUR ouvre la porte sur le port écrit dans web.env — aucun port dans son ENV", async (t) => {
  const { maison } = maisonJetable(t, null);
  const port = await portLibre();
  fs.writeFileSync(path.join(maison, "web.env"), `CC2CC_WEB_JETON=${"f".repeat(64)}\nCC2CC_WEB_PORT=${port}\nCC2CC_WEB_OPERATEUR=alice\n`, {
    mode: 0o600
  });

  const env = { ...envPropre(), CC2CC_V2_HOME: maison };
  delete env.CC2CC_WEB_PORT;
  delete env.CC2CC_WEB_HOTE;
  const enfant = spawn("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => enfant.kill("SIGTERM"));

  let sortie = "";
  const annonce = await new Promise((resolve, reject) => {
    const couperet = setTimeout(() => reject(new Error(`le lanceur n'a jamais annoncé sa porte : ${sortie}`)), 15_000);
    const lire = (bloc) => {
      sortie += bloc.toString("utf8");
      const trouve = sortie.match(/PORTE (\S+):(\d+)/);
      if (trouve) {
        clearTimeout(couperet);
        resolve({ hote: trouve[1], port: Number(trouve[2]) });
      }
    };
    enfant.stdout.on("data", lire);
    enfant.stderr.on("data", lire);
    enfant.on("exit", (code) => {
      clearTimeout(couperet);
      reject(new Error(`le lanceur est mort (code ${code}) : ${sortie}`));
    });
  });

  assert.equal(annonce.port, port, `web.env demandait ${port}, la porte annonce ${annonce.port}`);
  assert.equal(annonce.hote, "127.0.0.1");
});

test("⑩ un `CC2CC_WEB_HOTE` hostile écrit dans web.env est refusé comme s'il venait de l'ENV — la garde est sur le chemin réel", (t) => {
  const { maison } = maisonJetable(
    t,
    `CC2CC_WEB_JETON=${"g".repeat(64)}\nCC2CC_WEB_HOTE=0.0.0.0\nCC2CC_WEB_PORT=0\nCC2CC_WEB_OPERATEUR=alice\n`
  );
  const env = { ...envPropre(), CC2CC_V2_HOME: maison };
  delete env.CC2CC_WEB_PORT;
  delete env.CC2CC_WEB_HOTE;

  const lancement = spawnSync("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    encoding: "utf8",
    env,
    // ⚠️ SANS CE COUPERET, LE MUTANT NE ROUGIT PAS : IL PEND. Un lanceur qui
    // accepterait 0.0.0.0 resterait en écoute pour toujours.
    timeout: 20_000,
    killSignal: "SIGKILL"
  });

  assert.notEqual(lancement.status, 0, "le fichier gouverne l'hôte, DONC la garde de l'hôte s'y applique aussi");
  assert.match(lancement.stderr, /loopback interface \(127\.0\.0\.1/, "le refus se NOMME");
  assert.ok(!lancement.stdout.includes("PORTE"));
  assert.ok(!fs.existsSync(path.join(maison, "broker.db")), "le refus précède l'ouverture du bureau");
});

// J3 (jury, 18/10) — LE LANCEUR RESSERRE UN web.env FAIT À LA MAIN. La fonction pure est
// éprouvée dans test/web-jeton-merge.test.js ; ici, le lanceur la traverse pour de vrai :
// un web.env à 0644 qui porte le jeton et l'opérateur, la porte démarre, le fichier est
// 0600 ensuite, son contenu n'a pas bougé d'un octet, et la ligne est dite sur stderr —
// sans jamais montrer le jeton.
test("J3 — le lanceur ramène un web.env à 0644 à 0600, sans toucher à son contenu, et le dit sur stderr", async (t) => {
  const jeton = "j".repeat(64);
  const port = await portLibre();
  const contenu = `CC2CC_WEB_JETON=${jeton}\nCC2CC_WEB_PORT=${port}\nCC2CC_WEB_OPERATEUR=alice\n`;
  const { maison, fichier } = maisonJetable(t, contenu);
  fs.chmodSync(fichier, 0o644);

  const env = { ...envPropre(), CC2CC_V2_HOME: maison };
  delete env.CC2CC_WEB_PORT;
  delete env.CC2CC_WEB_HOTE;
  const enfant = spawn("node", [path.join(racine, "src", "bin", "valxos-web.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => enfant.kill("SIGTERM"));

  let sortie = "";
  await new Promise((resolve, reject) => {
    const couperet = setTimeout(() => reject(new Error(`le lanceur n'a jamais annoncé sa porte : ${sortie}`)), 15_000);
    const lire = (bloc) => {
      sortie += bloc.toString("utf8");
      if (/PORTE (\S+):(\d+)/.test(sortie)) {
        clearTimeout(couperet);
        resolve();
      }
    };
    enfant.stdout.on("data", lire);
    enfant.stderr.on("data", lire);
    enfant.on("exit", (code) => {
      clearTimeout(couperet);
      reject(new Error(`le lanceur est mort (code ${code}) : ${sortie}`));
    });
  });

  assert.equal(fs.statSync(fichier).mode & 0o777, 0o600, "le jeton n'est plus lisible par un autre compte");
  assert.equal(fs.readFileSync(fichier, "utf8"), contenu, "le contenu du fichier n'a pas bougé d'un octet");
  assert.ok(sortie.includes(`${fichier} holds the web door token and was readable by other accounts (mode 644); changed to 600.`), sortie);
  assert.ok(!sortie.includes(jeton), "ni le jeton ni rien qui y ressemble n'est imprimé");
});
