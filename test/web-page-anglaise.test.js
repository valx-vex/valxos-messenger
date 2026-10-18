// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA PAGE DE LA PORTE PARLE ANGLAIS (T4b-c, 18/10).
//
// `surfaces.test.js` lit toutes les surfaces du paquet SAUF `src/web/public/`,
// « qui a sa propre tâche ». C'est celle-ci. Le code interne reste en français
// (identifiants, commentaires, noms de tests) ; ce que l'opérateur lit ou
// entend sur la page est en anglais.
//
// Deux instruments, parce que les deux fichiers ne se lisent pas pareil :
//   · app.js passe par le détecteur de T4b-b (`aide-surfaces.js`), qui lit les
//     LITTÉRAUX et jamais les commentaires. Les seules chaînes françaises
//     admises sont les valeurs de `etat` que l'API rend — des codes, pas de
//     la prose : la page les compare, elle ne les affiche pas.
//   · index.html est petit et ses libellés sont courts : « Poster » ou « Ta
//     lettre » n'ont ni accent ni deux mots-outils, le détecteur ne les verrait
//     pas. On en tient donc l'INVENTAIRE, au caractère près.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parleFrancais, prosesFrancaises } from "./aide-surfaces.js";
import { dessinerPli, normaliserLettre } from "../src/web/public/app.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLI_SAIN = { nonPartie: false, refus: null, rejouable: true, accuseEnvoye: false };

// « en attente » et « au guichet », les deux autres valeurs de `etat`, ne
// portent ni accent ni deux mots-outils : le détecteur ne les relève pas.
const CODES_ADMIS = [
  { texte: "reçue", pourquoi: "valeur `etat` de etatDeLaLettre, comparée par la page" },
  { texte: "accusée", pourquoi: "valeur `etat` de etatDeLaLettre, comparée par la page" }
];

test("app.js : aucune prose française dans une chaîne — seuls les codes `etat` de l'API", () => {
  // L'INSTRUMENT DOIT POUVOIR VOIR SA CIBLE : un détecteur qui ne relève rien
  // passerait sur une page entièrement française.
  assert.equal(parleFrancais("Aucune lettre. Écris la première."), true, "SONDE IMPOSSIBLE : le détecteur est aveugle");
  const relevees = prosesFrancaises(repo, "src/web/public/app.js");
  for (const code of CODES_ADMIS) {
    assert.ok(
      relevees.some((r) => r.texte === code.texte),
      `le code admis « ${code.texte} » n'est plus dans app.js : retirez-le de la liste`
    );
  }
  const prose = relevees
    .filter((r) => !CODES_ADMIS.some((c) => c.texte === r.texte))
    .map((r) => `app.js:${r.ligne}: ${r.texte.slice(0, 120)}`);
  assert.deepEqual(prose, [], `prose française sur la page :\n${prose.join("\n")}`);
});

test("les quatre cachets disent les mots du README, et la voix dit le mot entier", () => {
  const cachet = (etat) => dessinerPli(normaliserLettre({ de: "bob-eternal", a: "alice", corps: "…", etat, postee_a: "2026-10-18T09:05:00Z" }), PLI_SAIN);
  const attendus = [
    ["en attente", "Waiting", "Waiting"],
    ["au guichet", "Carried", "Carried"],
    ["reçue", "Delivered", "Delivered"],
    // « Acknowledged » mesure 90 px sous le cachet, pour une case de 54 : le
    // tampon porte la forme courte, l'aria-label le mot du README.
    ["accusée", "Acked", "Acknowledged"]
  ];
  for (const [etat, mot, dit] of attendus) {
    const html = cachet(etat);
    assert.ok(html.includes(`<span class="cachet__mot">${mot}</span>`), `« ${etat} » se lit « ${mot} » sous le cachet (${html})`);
    assert.match(html, new RegExp(`aria-label="${dit} at \\d\\d:\\d\\d"`), `« ${etat} » se dit « ${dit} at HH:MM »`);
    assert.match(html, /<div class="pli__de"><b>bob-eternal<\/b>to alice/, "et l'adresse se lit « to »");
  }
});

// L'inventaire de ce que le document fait lire ou entendre, commentaires
// retirés : le texte entre les balises, puis les attributs lus par l'écran ou
// par la voix. Un libellé ajouté demain s'inscrit ici, exprès.
const INVENTAIRE_DU_DOCUMENT = [
  "VALXOS Messenger — web door",
  "VALXOS",
  "·",
  "Messenger",
  "·",
  "Live mailboxes",
  "to:",
  "…",
  "Post",
  "aria-label=A letter's journey",
  "aria-label=Mailboxes",
  "aria-label=Letters",
  "placeholder=Write your letter.",
  "aria-label=Your letter"
];

test("index.html : lang=\"en\", et chaque texte visible ou entendu est l'inventaire anglais, au caractère près", () => {
  const brut = fs.readFileSync(path.join(repo, "src/web/public/index.html"), "utf8");
  assert.match(brut, /<html lang="en">/, "la langue déclarée est celle que le lecteur d'écran prononcera");
  const html = brut.replace(/<!--[\s\S]*?-->/g, "");
  assert.ok(html.length < brut.length, "SONDE IMPOSSIBLE : aucun commentaire retiré, l'instrument ne lit pas ce fichier-là");
  const textes = [];
  for (const m of html.matchAll(/>([^<]+)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t) textes.push(t);
  }
  for (const m of html.matchAll(/\s(aria-label|placeholder|title|alt)="([^"]*)"/g)) textes.push(`${m[1]}=${m[2]}`);
  assert.deepEqual(textes, INVENTAIRE_DU_DOCUMENT);
  assert.deepEqual(textes.filter((t) => parleFrancais(t)), [], "et rien de ce qui se lit n'est français");
});
