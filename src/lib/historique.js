// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// L'HISTORIQUE EXPORTÉ (1.1.0, SPEC_A §1.8) — le fil d'une séance, en markdown,
// depuis la ligne de commande (`valxos-history`). Deux fonctions PURES : elles
// reçoivent des lignes de `messages` et rendent du texte ou des lignes ; aucune
// ne lit la base, aucune ne modifie ce qu'elle reçoit. Les corps de lettre sont
// du texte non fiable (SECURITY.md) : ils sortent tels quels, sans échappement,
// après une ligne vide, sous un en-tête qui dit qui écrit à qui.

// UN ENVOI, UNE ENTRÉE. Une lettre de table existe une fois par membre (le
// carnet d'adresses, SPEC_A §2) : le fil d'une table, lu par son expéditeur,
// répète le même corps autant de fois qu'il y a de membres. Pour le transcript,
// les lignes d'un même `envoi_id` se replient sur la première (le plus petit
// `seq`), adressée à `table:<nom>` quand la lettre porte sa table, et gardent
// la liste des destinataires. Une lettre sans `envoi_id` reste telle quelle.
// L'ordre rendu est celui de `seq`.
export function regrouperParEnvoi(rows) {
  const triees = [...rows].sort((a, b) => a.seq - b.seq);
  const parEnvoi = new Map();
  const resultat = [];
  for (const row of triees) {
    if (!row.envoi_id) {
      resultat.push(row);
      continue;
    }
    const deja = parEnvoi.get(row.envoi_id);
    if (deja) {
      deja.destinataires.push(row.recipient);
      continue;
    }
    const entree = {
      ...row,
      recipient: row.table_nom ? `table:${row.table_nom}` : row.recipient,
      destinataires: [row.recipient]
    };
    parEnvoi.set(row.envoi_id, entree);
    resultat.push(entree);
  }
  return resultat;
}

// Le markdown : un titre, le compte, puis une entrée par lettre — l'en-tête
// (`## qui → qui — quand`), une ligne de métadonnées en italique, une ligne
// vide, le corps. CHAQUE MÉTADONNÉE VENUE D'UNE LETTRE (l'expéditeur, le
// destinataire, la clef, le sujet, le fil, la table, l'envoi, la lettre à
// laquelle elle répond, les destinataires d'un envoi replié) est écrite comme un
// littéral JSON (`cite`) : guillemets échappés, retours à la ligne en `\n` —
// elle ne peut ni fermer sa ligne ni écrire un en-tête qu'elle n'est pas. Seuls
// restent nus ce que la base écrit elle-même : `seq` (un entier), la priorité
// (normalisée à l'inscription) et `created_at` (l'horloge du guichet, jamais
// tapée par un posteur). Le corps, lui, sort tel quel par conception.
const cite = (valeur) => JSON.stringify(String(valeur ?? ""));

export function exporterEnMarkdown(rows, { titre }) {
  const triees = [...rows].sort((a, b) => a.seq - b.seq);
  const lignes = [`# ${titre}`, "", `${triees.length} letter(s).`];
  for (const row of triees) {
    lignes.push("", `## ${cite(row.sender)} → ${cite(row.recipient)} — ${row.created_at}`);
    const meta = [`seq ${row.seq}`, `id ${cite(row.msg_id)}`, `priority ${row.priority}`];
    if (row.subject) meta.push(`subject ${cite(row.subject)}`);
    if (row.thread_id) meta.push(`thread ${cite(row.thread_id)}`);
    if (row.table_nom) meta.push(`table ${cite(row.table_nom)}`);
    if (row.envoi_id) meta.push(`envoi ${cite(row.envoi_id)}`);
    if (row.reponse_a) meta.push(`reply to ${cite(row.reponse_a)}`);
    if (Array.isArray(row.destinataires) && row.destinataires.length > 1) meta.push(`to ${row.destinataires.map(cite).join(", ")}`);
    // Une entrée repliée que `--limit` a coupée (posé par `valxos-history`) : ses
    // destinataires ne sont pas tous là, et l'entrée le dit.
    if (row.tronque === true) meta.push("cut by --limit");
    lignes.push(`_${meta.join(" · ")}_`, "", String(row.body ?? ""));
  }
  return `${lignes.join("\n")}\n`;
}
