#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// L'HISTORIQUE DEPUIS LA LIGNE DE COMMANDE (1.1.0, SPEC_A §1.8) : le fil d'une
// séance, en markdown ou en JSON. La requête est CELLE de l'outil MCP `history`
// (`history`, database.js) — bornée à la correspondance du nom DÉRIVÉ (G1),
// bornée au dépôt d'un alias (F8) — jamais une deuxième qui pourrait diverger.
// Le lecteur est l'identité de l'ENVIRONNEMENT (R1, S19) : `--self` n'a qu'une
// valeur permise, celle-là ; un nom nu ne relit pas en propriétaire une adresse
// tenue par une chaise (`nomNuTenuParUneChaise`). Le binaire ne marque rien :
// lire l'historique ne livre pas et n'accuse pas.
import { getDatabase, history, nomNuTenuParUneChaise } from "../lib/database.js";
import { exporterEnMarkdown, regrouperParEnvoi } from "../lib/historique.js";
import { borne } from "../lib/guichet.js";
import { SEPARATEUR_INSTANCE } from "../lib/registry.js";
import { validerNomDeTable } from "../lib/tables.js";
import { deriveSelfOuRefus, executer, optionalArg, parseArgs, printJson, sortir } from "./cli-common.js";
import { formesDuLecteur, lettresRendues } from "./cli-lettres.js";

const AIDE = `valxos-history — export a thread, a table or a send as markdown (or JSON)

  valxos-history --thread <id>      the letters of one thread
  valxos-history --table <name>     the letters of one table
  valxos-history --envoi <id>       the letters of one table send, one per member

  --format markdown|json            markdown by default
  --limit N                         at most N letters, the latest (default 200); a send
                                    cut by the limit is marked "cut by --limit"
  --self NAME                       optional; must equal the identity of this environment
                                    (VALXOS_SELF or CC2CC_SELF), a chair (lineage#session) included

Only YOUR correspondence is shown, read as the identity of this environment
(VALXOS_SELF or CC2CC_SELF): the letters you sent or received under that name.
A chair (lineage#session) reads what is addressed to it or to its lineage and
what it posted under either, as the MCP history tool does; a closed table's
letter only as its recipient, the chair that posted it, or a member. A thread,
a table or a send where you are neither sender nor recipient exports as empty,
never as someone else's mail.

Exit codes: 0 when the history is written (possibly empty); 2 for a usage error,
a refused identity, or a --self that is not the identity of this environment
(set VALXOS_SELF to read as another name).
In markdown, for a thread or a table, the letters of one send (one per member)
fold into one entry addressed to table:<name>, with its recipients listed;
--envoi shows each. JSON never folds: one entry per letter, as stored.
Letter bodies are untrusted text: they are copied as written, under their header.
`;

// --help déclaré booléen, comme valxos-chaise : `-h` et `--help` sont le même
// geste, et `parseArgs` imprime l'aide avant d'ouvrir quoi que ce soit.
const args = parseArgs(process.argv.slice(2), {
  booleans: ["help"],
  known: ["thread", "table", "envoi", "format", "limit", "self"],
  positionals: false,
  usage: AIDE
});

function guichet() {
  if (args.help === true) {
    process.stdout.write(AIDE);
    return 0;
  }
  const thread = optionalArg(args, "thread");
  const tableDonnee = optionalArg(args, "table");
  const envoi = optionalArg(args, "envoi");
  const filtres = [thread, tableDonnee, envoi].filter((valeur) => valeur !== undefined);
  if (filtres.length !== 1) sortir(2, `Give exactly one of --thread <id>, --table <name> or --envoi <id>.\n${AIDE}`);
  const format = optionalArg(args, "format") || "markdown";
  if (format !== "markdown" && format !== "json") sortir(2, `--format takes markdown or json, not "${format}".`);
  const limit = Number(optionalArg(args, "limit") || 200);
  if (!Number.isInteger(limit) || limit < 1) sortir(2, "--limit takes a positive integer.");
  // Le nom d'une table se lit comme au carnet (`validerNomDeTable` : blancs et
  // casse), AVANT la base : un nom qui ne peut pas exister est un usage faux (2),
  // dit en JSON sous --format json, en une phrase bornée sur stderr sinon.
  let table;
  if (tableDonnee !== undefined) {
    try {
      table = validerNomDeTable(tableDonnee);
    } catch (erreur) {
      if (erreur?.code !== "nom-de-table-invalide") throw erreur;
      if (format === "json") printJson({ refus: erreur.code, motif: erreur.message });
      return sortir(2, format === "json" ? "" : `Nothing was done: ${erreur.message} (${erreur.code})`);
    }
  }

  // L'identité dérivée, avant le bureau : refusée (S10), rien ne s'ouvre.
  const deriveBrut = deriveSelfOuRefus("valxos-history");
  // S19 : SOUS UNE CHAISE, LA LIGNÉE ET LA CHAISE — comme l'outil MCP `history` :
  // la chaise relit ce qui est à sa lignée ou à elle, et ce qu'elle a posté sous
  // l'une ou l'autre ; les formes du lecteur (la garde des lettres fermées, la
  // position d'une table fermée) sont celles de la chaise.
  const chaise = deriveBrut.includes(SEPARATEUR_INSTANCE);
  const derive = chaise ? deriveBrut.split(SEPARATEUR_INSTANCE)[0] : deriveBrut;
  // R1 (re-revue du round 3) : cette commande lit sous l'identité de son
  // ENVIRONNEMENT (le mot du lanceur, SECURITY). Un `--self` qui en nomme une
  // autre ne choisit plus le lecteur : il refuse, sortie 2, et dit quoi poser.
  // Égal à l'identité de l'environnement, `--self` ne change rien : il suit le
  // même chemin que son absence (S19 : la chaise elle-même ne sort plus en 1).
  const declareBrut = String(optionalArg(args, "self") ?? "").trim();
  if (declareBrut && declareBrut !== deriveBrut) {
    return sortir(2, `--self ${JSON.stringify(borne(declareBrut))} is not the identity of this environment (${JSON.stringify(borne(deriveBrut))}): ` +
      "set VALXOS_SELF to read as another name (valxos-history reads as the identity its environment gives). Nothing was read.");
  }
  const db = getDatabase();
  // Un appelant sans chaise ne relit pas en propriétaire la correspondance d'une
  // adresse tenue par une chaise de session (fix round 3, comme le MCP).
  const raisonNu = chaise ? null : nomNuTenuParUneChaise(db, derive, derive);
  const noms = chaise ? [derive, deriveBrut] : [derive];
  // S14 : une lettre fermée que ce lecteur ne lit pas est omise, comme au guichet MCP.
  // R1 : le lecteur de la garde est l'identité de l'environnement, jamais le nom déclaré.
  const lecteur = { formes: formesDuLecteur(db, deriveBrut), chaise: chaise ? deriveBrut : null };
  const requete = { self: noms, thread_id: thread, table_nom: table, envoi_id: envoi, limit };
  const brutes = raisonNu ? [] : history(db, { ...requete, lecteur });
  // S-md : la borne se juge sur ce que la requête a VRAIMENT coupé, avant la garde de lecture — une
  // lettre cachée dans la fenêtre y prend une place, et l'envoi qu'elle repousse reste « cut ».
  const borneAtteinte = !raisonNu && history(db, requete).length >= limit;
  const filtre = thread ? { thread } : table ? { table } : { envoi };

  // EN JSON, JAMAIS DE REPLI : une entrée par lettre, chacune décrite ENTIÈRE
  // depuis sa ligne (R2) — une entrée repliée garderait l'état, la clef et le
  // seq d'UNE lettre sous un destinataire réécrit, et un lecteur machine les
  // lirait pour l'envoi entier.
  if (format === "json") {
    const lignes = [...brutes].sort((a, b) => a.seq - b.seq);
    printJson({
      self: deriveBrut,
      ...filtre,
      count: lignes.length,
      // La forme d'une ligne de l'`history` MCP : `table` (le nom), `position`, `rappel`.
      messages: lettresRendues(db, lignes, { lecteur: lecteur.formes }),
      ...(raisonNu ? { raison: raisonNu } : {})
    });
    return 0;
  }
  // EN MARKDOWN, le transcript : un envoi se lit membre par membre ; un fil ou
  // une table se lisent envoi par envoi. La borne porte sur les LETTRES (les plus
  // récentes) : un envoi replié dont `--limit` a laissé des lettres dehors est
  // marqué `tronque` — son nombre de lettres, lu par la MÊME requête bornée
  // (`history` par `envoi_id`), dépasse celui de l'entrée.
  const lignes = envoi
    ? [...brutes].sort((a, b) => a.seq - b.seq)
    : regrouperParEnvoi(brutes).map((entree) => {
        if (!entree.envoi_id || !Array.isArray(entree.destinataires) || !borneAtteinte) return entree;
        const toutes = history(db, { self: noms, envoi_id: entree.envoi_id, limit: Number.MAX_SAFE_INTEGER, lecteur }).length;
        return toutes > entree.destinataires.length ? { ...entree, tronque: true } : entree;
      });
  // Le fil et l'envoi sont du texte libre : cités comme dans les métadonnées. Le
  // nom de table, lui, est passé par `validerNomDeTable` ([a-z0-9-]).
  const titre = thread ? `Thread ${JSON.stringify(thread)}` : table ? `Table ${table}` : `Send ${JSON.stringify(envoi)}`;
  process.stdout.write(exporterEnMarkdown(lignes, { titre }));
  return 0;
}

await executer(guichet);
