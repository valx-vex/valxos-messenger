// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PORTE SOUS UN CHEMIN AVEC ESPACE (revue sécurité F3, 18/10).
//
// `RACINE_PUBLIQUE` se calculait par `new URL("./public/", import.meta.url).pathname` :
// un chemin PERCENT-ENCODÉ. Sous `~/My Projects/valxos/` ou sous `~/Library/Application
// Support/…`, il devenait `My%20Projects` — dossier introuvable. La porte démarrait,
// annonçait son URL, posait son jeton… et ne servait AUCUN fichier : `GET /` rendait
// 404 `fichier-absent`, et la table des polices (`routesDesPolices`, qui avale l'ENOENT)
// restait VIDE. Le dépôt connaissait la règle (« fileURLToPath, jamais `.pathname` »,
// config.js et plists.js) et ne l'appliquait pas ici.
//
// Le test joue le cas pour de vrai : une COPIE RÉELLE du paquet sous un dossier dont le
// nom contient un espace — pas un lien symbolique, que Node résout vers le chemin
// d'origine et qui ne prouverait rien. `node_modules` y est lié (les dépendances n'ont
// pas à bouger avec le paquet), et la porte se démarre depuis la copie, comme un inconnu
// qui clone là.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { envPropre } from "./aide-env.js";

const racine = path.resolve(new URL("..", import.meta.url).pathname);

// Le paquet tel qu'on le clone : `src/`, son manifeste, et les dépendances (liées).
function copieSousUnEspace(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "valxos chemin avec espace-")));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const copie = path.join(parent, "mon paquet");
  fs.mkdirSync(copie);
  fs.cpSync(path.join(racine, "src"), path.join(copie, "src"), { recursive: true });
  fs.copyFileSync(path.join(racine, "package.json"), path.join(copie, "package.json"));
  fs.symlinkSync(path.join(racine, "node_modules"), path.join(copie, "node_modules"), "dir");
  assert.ok(copie.includes(" "), "SONDE : le chemin de la copie contient bien un espace");
  assert.ok(pathToFileURL(copie).href.includes("%20"), "SONDE : et son URL le percent-encode, ce que `.pathname` rendait tel quel");
  return { parent, copie };
}

const clefs = (routes) => routes.map((ligne) => `${ligne.methode} ${ligne.chemin}`).sort();

test("sous un chemin avec espace, la table des routes est COMPLÈTE : les huit polices y sont", async (t) => {
  const { copie } = copieSousUnEspace(t);
  const { ROUTES: routesDeLaCopie } = await import(pathToFileURL(path.join(copie, "src", "web", "serveur.js")).href);
  const { ROUTES: routesDuDepot } = await import("../src/web/serveur.js");

  assert.equal(routesDuDepot.filter((ligne) => ligne.chemin.startsWith("/polices/")).length, 8, "SONDE : le dépôt sert huit polices");
  assert.deepEqual(clefs(routesDeLaCopie), clefs(routesDuDepot), "la copie sert exactement les mêmes routes que le dépôt");
});

function obtenir(port, chemin, cookie = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: chemin, method: "GET", headers: cookie ? { cookie } : {} },
      (res) => {
        const morceaux = [];
        res.on("data", (bloc) => morceaux.push(bloc));
        res.on("end", () => resolve({ statut: res.statusCode, entetes: res.headers, corps: Buffer.concat(morceaux) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("sous un chemin avec espace, la porte lancée depuis la copie SERT sa page : GET / → 200, et une police aussi", async (t) => {
  const { parent, copie } = copieSousUnEspace(t);
  const bureau = path.join(parent, "bureau");
  fs.mkdirSync(bureau, { mode: 0o700 });
  const jeton = "e".repeat(64);
  fs.writeFileSync(path.join(bureau, "web.env"), `CC2CC_WEB_JETON=${jeton}\nCC2CC_WEB_OPERATEUR=alice\nCC2CC_WEB_PORT=0\n`, { mode: 0o600 });

  const env = envPropre({ CC2CC_V2_HOME: bureau, HOME: parent });
  delete env.CC2CC_WEB_PORT;
  delete env.CC2CC_WEB_HOTE;
  const enfant = spawn(process.execPath, [path.join(copie, "src", "bin", "valxos-web.js")], {
    env, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => enfant.kill("SIGTERM"));

  let sortie = "";
  const port = await new Promise((resolve, reject) => {
    const couperet = setTimeout(() => reject(new Error(`la porte n'a jamais annoncé son adresse : ${sortie}`)), 15_000);
    const lire = (bloc) => {
      sortie += bloc.toString("utf8");
      const trouve = sortie.match(/PORTE (\S+):(\d+)/);
      if (trouve) {
        clearTimeout(couperet);
        resolve(Number(trouve[2]));
      }
    };
    enfant.stdout.on("data", lire);
    enfant.stderr.on("data", lire);
    enfant.on("exit", (code) => {
      clearTimeout(couperet);
      reject(new Error(`la porte est morte (code ${code}) : ${sortie}`));
    });
  });

  // La première visite pose le cookie (le jeton ne reste pas dans l'URL), comme un navigateur.
  const visite = await obtenir(port, `/?t=${jeton}`);
  assert.equal(visite.statut, 302, "SONDE : le marque-page est accepté");
  const cookie = String(visite.entetes["set-cookie"] || "").split(";")[0];
  assert.ok(cookie, "SONDE : la porte a posé son cookie");

  const page = await obtenir(port, "/", cookie);
  assert.equal(page.statut, 200, `GET / : ${page.corps.toString("utf8").slice(0, 200)}`);
  assert.match(page.entetes["content-type"], /text\/html/);
  assert.match(page.corps.toString("utf8"), /<html/i, "c'est la vraie page");

  const police = await obtenir(port, "/polices/archivo-400-800-latin.woff2", cookie);
  assert.equal(police.statut, 200, "une police est servie");
  assert.equal(police.corps.subarray(0, 4).toString("ascii"), "wOF2", "avec ses vrais octets");
});
