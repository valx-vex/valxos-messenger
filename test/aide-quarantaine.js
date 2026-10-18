// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA QUARANTAINE D'UN TEST — nommée, raisonnée, inscrite (Run 6, tâche 1).
//
// `quarantaine(tag, raison, condition)` rend l'argument d'options de
// `test(nom, options, fn)` de node:test : `{ skip: "QUARANTAINE <tag> — <raison>" }`
// quand la condition tient (l'absence que le test exige est constatée), `{}`
// sinon — le test joue. Le tag est `RUN6-Q<n>` et a sa ligne dans
// docs/QUARANTAINE.md ; test/quarantaine.test.js le garde. Un skip n'est
// jamais un effacement silencieux.
export function quarantaine(tag, raison, condition = true) {
  if (!/^RUN6-Q\d+$/.test(String(tag))) throw new Error("une quarantaine exige un tag RUN6-Q<n>");
  if (!String(raison || "").trim()) throw new Error("une quarantaine exige une raison nommée");
  return condition ? { skip: `QUARANTAINE ${tag} — ${raison}` } : {};
}
