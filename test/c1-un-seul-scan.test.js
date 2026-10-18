// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// C1 AU NIVEAU DE LA SURFACE — une diffusion, UN SEUL scan des maisons.
//
// ⚠️ POURQUOI CE FICHIER EXISTE (trouvaille ③, 22/08). Le test du guichet
// (`test/guichet.test.js`) prouve la CAPACITÉ du guichet : un `{houses,
// parSession}` fourni se réutilise. Il ne dira jamais que `broadcast` le
// fournit. Mutation exécutée pour le prouver : supprimer `, { maisons }` de
// l'appel dans la boucle de `broadcast` (src/mcp-server/server.js) →
// 499 pass / 0 fail. Conséquence mesurée : avec 12 lignées inscrites, 12 scans
// au lieu d'un (≈65 ms chacun) — et surtout 12 scans PRIS À DES INSTANTS
// DIFFÉRENTS. Une maison qui disparaît pendant la boucle fait que les cibles 1
// à 5 reçoivent `attente: null` et les 6 à 12 `attente:{motif:
// 'maison-inconnue'}`, pour un état que la loi déclare invariant « d'une cible
// à l'autre dans le MÊME appel ».
//
// HONNÊTETÉ, à ne pas perdre : `main` partage exactement ce trou (déplacer le
// scan dans la boucle sur main donne 493/0). Ce test ne répare donc PAS une
// régression de couverture — il ferme une porte ouverte depuis toujours, que
// l'extraction du guichet a rendue plus facile à franchir et que la prochaine
// surface (la porte web) allait franchir la première.
//
// ⚠️ L'INSTRUMENT : ON COMPTE LES VRAIS SCANS, PAS UN DOUBLE. Le serveur MCP
// tourne dans un AUTRE processus ; aucun compteur injecté ne peut le voir. On
// se sert donc de ce qu'un scan RÉEL fait quand il rencontre une fiche sans
// `procStart` : `verdictDeVivacite` (postbox.js) SONDE la boîte, c'est-à-dire
// qu'il ouvre une vraie connexion sur la socket de la fiche. Ce fichier pose
// donc une vraie socket qui ÉCOUTE et compte ses connexions. Une connexion =
// une tournée des maisons, vue depuis le disque et le noyau, pas depuis une
// doublure.
//
// ⚠️ Base et maison JETABLES (mkdtemp + CC2CC_V2_HOME) : le bureau vivant
// (~/.cc2cc-v2) n'est jamais ouvert ici (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDatabase } from "../src/lib/database.js";
import { registerInstance } from "../src/lib/registry.js";
import { envPropre, poserLeBureau } from "./aide-env.js";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-c1-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

const repo = path.resolve(new URL("..", import.meta.url).pathname);

// Les sockets unix ont un chemin BORNÉ (sun_path, 104 octets sur macOS). Un
// chemin trop long ne lève pas ici : il ferait échouer la sonde EN SILENCE, et
// le compteur lirait 0 — un vert pour la mauvaise raison. On le refuse fort.
function socketCourte(nom) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "c1-"));
  const chemin = path.join(dossier, nom);
  assert.ok(
    Buffer.byteLength(chemin) < 100,
    `SONDE IMPOSSIBLE : chemin de socket trop long (${chemin.length}) — la sonde échouerait sans un mot`
  );
  return chemin;
}

test("une diffusion vers N lignées ne fait QU'UN scan des maisons — compté sur de vraies sondes", { timeout: 60_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-c1-home-"));
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-c1-maison-"));
  const sessions = path.join(maison, "sessions");
  fs.mkdirSync(sessions, { recursive: true });

  // LA BOÎTE QUI COMPTE. Chaque tournée réelle des maisons ouvre exactement une
  // connexion ici (une fiche sans `procStart` ⇒ une sonde). Le compteur est
  // donc un compteur de TOURNÉES.
  let connexions = 0;
  const chemin = socketCourte("boite.sock");
  const boite = net.createServer((flux) => {
    connexions += 1;
    flux.destroy();
  });
  await new Promise((resolve, reject) => {
    boite.once("error", reject);
    boite.listen(chemin, resolve);
  });
  t.after(() => new Promise((resolve) => boite.close(resolve)));

  const db = openDatabase({ file: path.join(root, "broker.db") });
  const sessionSondee = "c1c1c1c1-0000-4000-8000-000000000001";
  // TROIS lignées au moins : c'est le pluriel qui fait la loi. Une seule cible
  // rendrait « un scan » vrai même dans le monde cassé.
  registerInstance(db, { lineage: "cible-une", sessionId: sessionSondee, house: maison, pid: process.pid });
  registerInstance(db, {
    lineage: "cible-deux",
    sessionId: "c1c1c1c1-0000-4000-8000-000000000002",
    house: maison,
    pid: process.pid
  });
  registerInstance(db, {
    lineage: "cible-trois",
    sessionId: "c1c1c1c1-0000-4000-8000-000000000003",
    house: maison,
    pid: process.pid
  });
  db.close();

  // La fiche SANS `procStart` : c'est ce qui force la voie « sonde » de
  // `verdictDeVivacite` plutôt que la voie « registre » (qui, elle, ne
  // toucherait aucune socket et ne se compterait pas).
  fs.writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({ messagingSocketPath: chemin, pid: process.pid, sessionId: sessionSondee })
  );

  const client = new Client({ name: "cc2cc-c1-un-seul-scan", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(repo, "src/mcp-server/server.js")],
    env: {
      ...envPropre(),
      CC2CC_V2_HOME: root,
      // UNE SEULE maison à l'inventaire : la nôtre. Sans ça la tournée irait
      // voir les vraies maisons de la machine.
      CC2CC_MAISONS: maison,
      CC2CC_SELF: "posteur-c1"
    }
  });
  await client.connect(transport);
  try {
    const diffusion = await client.callTool({ name: "broadcast", arguments: { body: "appel général" } });
    const contenu = JSON.parse(diffusion.content[0].text);
    assert.ok(contenu.count >= 3, `la diffusion doit toucher au moins 3 lignées, pas ${contenu.count}`);
  } finally {
    await client.close();
  }

  // Les connexions arrivent dans NOTRE boucle d'événements ; on lui laisse le
  // temps de les servir avant de lire le compteur. Un compteur lu trop tôt
  // lirait 0 — et 0 serait plus petit que 1, donc vert par accident : d'où le
  // plancher ci-dessous, qui refuse le « rien vu » avant tout verdict.
  await new Promise((resolve) => setTimeout(resolve, 400));

  // TROIS ISSUES, JAMAIS DEUX : conforme · incohérence · sonde impossible.
  assert.ok(
    connexions >= 1,
    "SONDE IMPOSSIBLE : aucune tournée n'a frappé à la boîte — l'instrument ne voit pas sa cible, ce test ne prouve RIEN"
  );
  assert.equal(
    connexions,
    1,
    `C1 : UN scan pour toute la diffusion, pas ${connexions} — un scan par cible, ce sont des instants différents, et deux cibles du MÊME appel peuvent alors recevoir deux avis contradictoires sur le même état`
  );
});
