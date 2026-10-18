// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE DÉFAUT DU COMPOSEUR — sur qui la porte s'ouvre-t-elle ?
//
// POURQUOI CE FICHIER EXISTE. 23/08, première ouverture de l'opérateur : le
// composeur s'est ouvert sur « à : poste-heritage ». Un nom de MACHINE — né du
// repli sur le nom d'hôte quand une session ne dérive pas de nom propre — qui
// passait devant tout le monde parce qu'une majuscule trie avant une
// minuscule. Écrire à son propre Mac par défaut, dans sa propre boîte.
//
// La règle d'avant disait « la première boîte vivante ». Ce n'était pas un
// critère, c'était un TRI : elle rendait une réponse juste par accident tant
// que l'alphabet était d'accord. Un défaut qui dépend de l'ordre des noms est
// un défaut qui changera le jour où quelqu'un s'inscrira sous « Aaa ».
import test from "node:test";
import assert from "node:assert/strict";
import { choisirLaDestination, normaliserBoite } from "../src/web/public/app.js";

const MOI = "alice";
// Le registre RÉEL de l'opérateur le 23/08 au matin, tel que /api/pairs le rend
// (les comptes de chaises sont ceux du jour ; les noms sont des exemples).
const REGISTRE = [
  { nom: "poste-heritage", en_service: true, chaises: 4 },
  { nom: "amb", en_service: false, chaises: 2 },
  { nom: "claude-alice", en_service: true, chaises: 13, designee: "903067cb" },
  { nom: "bob-eternal", en_service: true, chaises: 1 },
  { nom: "alice", en_service: true, chaises: 0 }
].map(normaliserBoite);

test("LE DÉFAUT VA À QUELQU'UN À QUI IL PARLE — pas au premier de l'alphabet", () => {
  // Son fil porte du courrier de claude-alice, et de personne d'autre.
  const correspondants = new Set(["claude-alice"]);
  assert.equal(
    choisirLaDestination(REGISTRE, null, MOI, correspondants),
    "claude-alice",
    "le composeur doit s'ouvrir sur un correspondant vivant, jamais sur un nom de machine trié en tête"
  );
});

test("UN CORRESPONDANT MORT NE GAGNE PAS — la lettre irait dormir", () => {
  const correspondants = new Set(["amb"]); // inscrite, mais hors service
  const choix = choisirLaDestination(REGISTRE, null, MOI, correspondants);
  assert.notEqual(choix, "amb", "une fiche hors service ne devient pas le défaut, même si on lui a déjà écrit");
  assert.equal(choix, "claude-alice", "à défaut de correspondant vivant : la lignée où il y a le plus de monde");
});

test("SANS AUCUN CORRESPONDANT — la lignée la plus VIVANTE, pas la première", () => {
  assert.equal(
    choisirLaDestination(REGISTRE, null, MOI, new Set()),
    "claude-alice",
    "13 chaises battent 4 : « où il y a du monde » est un critère, « premier de l'alphabet » n'en est pas un"
  );
  // Et sans même la notion de correspondant (l'ancien appel à trois arguments).
  assert.equal(choisirLaDestination(REGISTRE, null, MOI), "claude-alice");
});

test("IL NE S'ÉCRIT JAMAIS À LUI-MÊME, ET SON CHOIX SURVIT À UNE REPEINTURE", () => {
  assert.notEqual(choisirLaDestination(REGISTRE, null, MOI, new Set([MOI])), MOI);
  // Le choix de l'humain prime sur toute préférence : une boîte qu'il a
  // désignée reste la sienne, même si elle meurt entre deux repeintures.
  assert.equal(choisirLaDestination(REGISTRE, "bob-eternal", MOI, new Set(["claude-alice"])), "bob-eternal");
});

test("LE DÉPARTAGE EST STABLE — un même registre rend toujours la même réponse", () => {
  const melange = [...REGISTRE].reverse();
  assert.equal(
    choisirLaDestination(melange, null, MOI, new Set()),
    choisirLaDestination(REGISTRE, null, MOI, new Set()),
    "l'ordre du registre ne doit plus décider de rien"
  );
});

// F6 (revues T4b-d2 et finale, 18/10) — LA FICHE NORMALISÉE PORTE SES CHAISES.
// Le défaut du composeur (`choisirLaDestination`, « où il y a du monde ») compte les
// chaises en service de chaque boîte. `normaliserBoite` les jetait : la fiche n'avait plus
// de `chaises`, tous les comptes valaient `undefined`, et le tri retombait sur l'alphabet —
// juste par accident tant que l'alphabet était d'accord. Les tests ci-dessus le prouvent par
// leur effet ; celui-ci tient la forme DIRECTEMENT, pour que la cause rougisse nommée.
test("normaliserBoite porte `chaises` : un entier ≥ 0, et tout ce qui n'est pas un nombre fini vaut 0", () => {
  const chaises = (brut) => normaliserBoite({ nom: "boite", en_service: true, ...brut }).chaises;

  assert.ok(Object.hasOwn(normaliserBoite({ nom: "boite" }), "chaises"), "la clef existe, même sur une fiche réduite à son nom");
  assert.equal(chaises({ chaises: 13 }), 13, "le compte de l'API passe tel quel");
  assert.equal(chaises({ chaises: 0 }), 0);
  assert.equal(chaises({ chaises: "4" }), 4, "un compte écrit en chaîne reste un compte");
  assert.equal(chaises({ chaises: 2.9 }), 2, "tronqué à l'entier");
  assert.equal(chaises({ chaises: -3 }), 0, "jamais négatif");

  for (const [brut, quoi] of [
    [undefined, "absent"],
    [null, "null"],
    ["beaucoup", "une chaîne qui n'est pas un nombre"],
    [NaN, "NaN"],
    [Infinity, "l'infini"],
    [-Infinity, "moins l'infini"],
    [{}, "un objet"]
  ]) {
    const valeur = chaises({ chaises: brut });
    assert.equal(typeof valeur, "number", `${quoi} : un nombre, pas ${typeof valeur}`);
    assert.equal(valeur, 0, `${quoi} : zéro, jamais NaN ni undefined`);
  }
});
