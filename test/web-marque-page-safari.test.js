// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE MARQUE-PAGE DE L'IPHONE — la toute première chose que la porte dit au monde.
//
// POURQUOI CE FICHIER EXISTE. Le 23/08 au matin, l'opérateur a ouvert la porte
// pour la première fois depuis son iPhone. **Safari a téléchargé un fichier au
// lieu d'afficher la page.** Il a fini sur le Mac.
//
// La cause, mesurée sur la réponse réelle servie par le tailnet : la
// redirection du marque-page (`?t=<jeton>` → `/`) partait avec
// `content-length: 0`, AUCUN `content-type`, et `x-content-type-options:
// nosniff` — qui interdit au navigateur de deviner le type. Safari s'est donc
// retrouvé avec une réponse sans type qu'il n'avait pas le droit de renifler :
// il en a fait un fichier. Le `200 text/html` derrière était parfait ; il ne
// l'a jamais atteint.
//
// CE QUE ÇA APPREND, ET QUI DÉPASSE SAFARI : une réponse sans corps n'est pas
// une réponse sans type. Les 234 vérifications de la suite regardaient le
// `Location`, le cookie, le code — et aucune ne regardait de quoi cette
// réponse avait l'air pour un navigateur. Le seul appareil qui comptait
// vraiment pour ce produit — le téléphone qu'on allait filmer — était le seul
// que rien ne représentait.
//
// ⚠️ Plancher jetable (CC2CC_V2_HOME) posé AVANT le premier test — voir
// aide-porte.js (remède de la revue adverse F2).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUREAU_INITIAL = process.env.CC2CC_V2_HOME;
poserLeBureau(fs.mkdtempSync(path.join(os.tmpdir(), "cc2cc-porte-safari-plancher-")));
after(() => {
  if (BUREAU_INITIAL === undefined) delete process.env.CC2CC_V2_HOME;
  else process.env.CC2CC_V2_HOME = BUREAU_INITIAL;
});

import { JETON, bureauJetable, porteDeTest, requete } from "./aide-porte.js";
import { poserLeBureau } from "./aide-env.js";

// Les réponses qui ont un corps VIDE ou COURT et qu'un navigateur reçoit
// quand même. Chacune doit dire de quoi elle est faite : `nosniff` est posé
// sur TOUTES les réponses de la porte, donc une réponse sans type est une
// réponse qu'un navigateur strict a le droit de refuser d'afficher.
test("LE MARQUE-PAGE : la redirection dit de quoi elle est faite — sinon Safari la télécharge", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });

  const visite = await requete(base, `/?t=${JETON}`);

  // L'instrument doit POUVOIR voir sa cible : si ce n'est pas la redirection
  // du marque-page, le reste du test ne prouve rien.
  assert.equal(visite.statut, 302, "SONDE IMPOSSIBLE : ce n'est pas la redirection du marque-page");
  assert.ok(visite.entetes.location, "SONDE IMPOSSIBLE : pas de Location, ce n'est pas une redirection");

  // LE CŒUR. `nosniff` interdit de deviner ; sans type, il ne reste rien.
  assert.equal(
    visite.entetes["x-content-type-options"],
    "nosniff",
    "le décor de ce test suppose nosniff — sans lui le défaut ne se produit pas"
  );
  assert.match(
    String(visite.entetes["content-type"] || ""),
    /^text\/html\s*;\s*charset=utf-8$/i,
    "la redirection du marque-page doit porter son type : sans lui, et avec nosniff, Safari iOS télécharge la réponse au lieu de la suivre"
  );
});

test("LE MARQUE-PAGE : si la redirection ne part pas, il reste un lien à toucher", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });

  const visite = await requete(base, `/?t=${JETON}`);
  const corps = String(visite.brut ?? visite.texte ?? visite.corps ?? "");

  assert.ok(corps.length > 0, "une redirection sans corps ne laisse rien à faire au lecteur qu'elle n'emmène pas");
  assert.match(corps, /<a href="\//, "le corps de secours doit porter un lien vers la porte");
  // Le lien pointe où la redirection pointe : deux cibles différentes seraient
  // deux vérités, et c'est exactement ce qu'on passe la journée à éviter.
  assert.ok(
    corps.includes(`href="${visite.entetes.location}"`),
    `le lien de secours doit viser la MÊME cible que l'en-tête Location (${visite.entetes.location})`
  );
});

test("TOUTE RÉPONSE QUI PORTE UN CORPS DIT DE QUOI IL EST FAIT — la classe, pas le cas", async (t) => {
  const db = bureauJetable(t);
  const { base } = await porteDeTest(t, { db });

  // On ne ferme pas un cas, on ferme une classe : chaque surface que la porte
  // peut rendre à un navigateur, avec et sans jeton.
  const surfaces = [
    [`/?t=${JETON}`, "GET", null],
    ["/", "GET", null],
    ["/api/pairs", "GET", null],
    ["/nexistepas", "GET", null],
    ["/api/poster", "GET", null]
  ];

  const muettes = [];
  for (const [chemin, methode] of surfaces) {
    const r = await requete(base, chemin, { methode });
    const type = String(r.entetes["content-type"] || "");
    const taille = Number(r.entetes["content-length"] ?? 0);
    // Une réponse VIDE a le droit de se taire sur son type (401 sans corps :
    // c'est délibéré, on ne dit rien de ce qui existe derrière). Une réponse
    // qui porte des octets, non.
    if (taille > 0 && !type) muettes.push(`${methode} ${chemin} → ${r.statut}, ${taille} octets, sans type`);
  }

  assert.deepEqual(
    muettes,
    [],
    "des octets partent sans dire de quoi ils sont faits — avec nosniff, un navigateur strict a le droit de les télécharger"
  );
});
