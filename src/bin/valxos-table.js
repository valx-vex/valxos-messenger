#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LA TABLE — le geste humain des tables (1.1.0, SPEC_A §5 ; décision A2 : les
// tables fermées s'administrent par la CLI seule dans cette version, l'outil
// MCP `table_manage` refuse `add`/`remove`/`create fermée`/`enclos`).
//
// Cet outil ne lit AUCUNE lettre et n'en marque aucune : ses seuls effets sont
// des écritures du carnet (`tables`, `table_membres`, `enclos`), et rien ne s'y
// efface (Camp B) : un membre retiré est marqué `retire_le`, une table ne se
// supprime pas, un enclos levé est marqué `retire_le` lui aussi. L'opérateur
// voit TOUTES les tables, fermées comprises : la discrétion d'une table fermée
// vaut pour les chaises (`tables` MCP), pas pour la main qui l'administre.
//
// Les règles vivent au carnet (tables.js) : cet outil valide l'USAGE (une
// commande, ses mots, ses drapeaux) avant d'ouvrir la base, puis appelle. Un
// refus du carnet se dit en JSON sous --json, en une phrase sur stderr sinon :
// sortie 2 pour une entrée qui ne peut pas être juste (un nom, une adresse, une
// règle), 1 pour un état qui refuse (la table existe, n'existe pas, est sous
// enclos…). Une erreur qui n'est pas un refus connu remonte telle quelle.
import { getDatabase } from "../lib/database.js";
import { positionCitee } from "../lib/format.js";
import { borne } from "../lib/guichet.js";
import {
  ajouterMembre,
  creerTable,
  enclosDeTable,
  enclosDesAutresFormes,
  enclosQuiTiennent,
  estMembre,
  membresDeTable,
  modifierTable,
  obtenirTable,
  poserEnclos,
  retirerEnclos,
  retirerMembre,
  validerAdresse,
  validerMode,
  validerNomDeTable,
  validerReveil
} from "../lib/tables.js";
import { deriveSelfOuRefus, executer, optionalArg, parseArgs, printJson, sortir } from "./cli-common.js";

const AIDE = `valxos-table — the address book of the tables (a human gesture)

  valxos-table creer <name> [--fermee] [--reveil reveil|prochain-tour] [--mode normal|direct]
                                            create a table (closed with --fermee)
  valxos-table ajouter <name> <address>...   add members (a lineage, a chair, a human address)
                                            [--reveil reveil|prochain-tour] for these members only;
                                            without it, a member coming back keeps its own rule
  valxos-table retirer <name> <address>...   mark members as withdrawn (nothing is erased)
  valxos-table fermer <name>                 close the table: members move by this tool only,
                                            its letters give no copy to another chair
  valxos-table ouvrir <name>                 open it again (refused while a sender is enclosed in it)
  valxos-table reveil <name> <rule>          the table's wake rule (reveil or prochain-tour)
                                            [--membre <address>] sets one member's rule instead
  valxos-table mode <name> <mode>            normal, or direct (a reaction wakes nobody)
  valxos-table position <name> <text>...     the shared position shown in every letter header
  valxos-table enclos <sender> <name>        the sender writes only to this CLOSED table,
                                            of which it must be an active member
                                            (one at a time: lift it before another)
  valxos-table enclos --retirer <sender>     lift the enclosure
  valxos-table lister                        every table, closed ones included
  valxos-table voir <name>                   one table, its members, its enclosed senders

  valxos-table aide                          this help (also -h, --help, or no command)
  --json                                    the same, for machines

A table is an address book, not a mailbox: sending to table:<name> posts one
letter per member, and no letter is ever "at the table". A closed table is
seen by its members only; this tool sees them all. In a table, priority high and critical
always wake; low never does; prochain-tour waits for the next turn.
Exit codes: 0 done, 1 refused by the address book, 2 wrong usage.
`;

// --json/--help/--fermee/--retirer déclarés BOOLÉENS (ils n'avalent jamais le
// mot suivant) ; --reveil/--mode/--membre prennent une valeur. Un drapeau hors
// liste rend l'aide et sort 2 avant toute base.
const args = parseArgs(process.argv.slice(2), {
  booleans: ["json", "help", "fermee", "retirer"],
  known: ["reveil", "mode", "membre"],
  usage: AIDE
});
const [commande, premier, ...reste] = args._;
const json = args.json === true;

// Qui fait le geste : le nom dérivé de l'environnement (le même repère que
// valxos-send et valxos-inbox) — signé dans `creee_par`, `ajoute_par`,
// `retire_par`, `position_par`, `pose_par`. Une identité refusée (S10) : sortie 2.
// N2 (re-revue du round 2) : dérivé APRÈS l'aide (`guichet`) — l'aide se sert à
// tous, sous une identité refusée comme sous aucune.
let operateur = null;

// La base s'ouvre au premier geste qui la lit : un usage refusé (nom, adresse,
// règle, drapeau) n'ouvre rien et ne crée aucun bureau en passant.
let base = null;
const db = () => (base ??= getDatabase());

// Les codes du carnet que cet outil sait rendre. Les quatre premiers disent une
// entrée qui ne peut pas être juste (usage, 2) ; les autres, un état qui refuse (1).
const REFUS_D_USAGE = new Set(["nom-de-table-invalide", "adresse-invalide", "reveil-invalide", "mode-invalide"]);
const REFUS_D_ETAT = new Set(["table-existe", "table-inconnue", "pas-membre", "enclos-table-ouverte", "enclos-existe", "table-sous-enclos"]);

function refuser(erreur) {
  const code = erreur?.code;
  if (!REFUS_D_USAGE.has(code) && !REFUS_D_ETAT.has(code)) throw erreur;
  if (json) printJson({ ok: false, refus: code, message: erreur.message });
  return sortir(REFUS_D_USAGE.has(code) ? 2 : 1, json ? "" : `Nothing was done: ${erreur.message} (${code})`);
}

// Un refus que l'outil pose lui-même, sous un code du carnet.
function refus(code, message) {
  const erreur = new Error(message);
  erreur.code = code;
  return erreur;
}

const lisible = (table) => ({ ...table, fermee: Number(table.fermee) === 1 });

// LES ENTRÉES SE VALIDENT PAR LE CARNET, AVANT LA BASE. Un nom, une règle de
// réveil, un mode, une adresse de membre : les validateurs PURS de tables.js
// (`validerNomDeTable`, `validerReveil`, `validerMode`, `validerAdresse`),
// jamais une copie de leur règle. Ce qu'ils rendent est la valeur nettoyée
// (blancs autour, casse du nom) ; ce qu'ils refusent passe par `refuser` :
// sortie 2, en `{ ok: false, refus, message }` sous --json. Une adresse passe
// TELLE QU'ÉCRITE : aucune forme n'est déduite d'une autre (la lignée n'est pas
// sa chaise).
function parLeCarnet(valider, valeur) {
  try {
    return valider(valeur);
  } catch (erreur) {
    return refuser(erreur);
  }
}

function nomDeTable(nom, usage) {
  if (nom === undefined) sortir(2, usage);
  return parLeCarnet(validerNomDeTable, nom);
}

const regleDeReveil = (regle) => parLeCarnet(validerReveil, regle);
const modeDeTable = (mode) => parLeCarnet(validerMode, mode);
const adresseDeMembre = (adresse) => parLeCarnet(validerAdresse, adresse);

function tableExistante(nom) {
  const table = obtenirTable(db(), nom);
  if (!table) throw refus("table-inconnue", `no table named "${nom}"`);
  return table;
}

// La sortie lisible cite ce qu'un autre a pu écrire (une adresse ajoutée par une
// session, un nom d'opérateur) sous la borne du guichet : 64 points de code,
// contrôles aplatis — un terminal ne reçoit jamais une séquence d'échappement.
// La position, elle, sort comme dans l'en-tête des lettres (`positionCitee`).
function montrerTable(table) {
  const membres = membresDeTable(db(), table.nom);
  const enclos = enclosDeTable(db(), table.nom);
  if (json) {
    printJson({ table: lisible(table), membres, enclos });
    return;
  }
  const lignes = [`Table "${table.nom}" (${Number(table.fermee) === 1 ? "CLOSED" : "open"}): wake ${table.reveil}, mode ${table.mode}`];
  const position = positionCitee(table.position);
  if (position) lignes.push(`  position: ${position}  (by ${borne(table.position_par ?? "?")}, ${table.position_le ?? "?"})`);
  lignes.push(`  members (${membres.length}):`);
  const adresses = membres.map((m) => borne(m.adresse));
  const largeur = Math.max(0, ...adresses.map((a) => a.length));
  membres.forEach((m, i) => {
    lignes.push(`    ${adresses[i].padEnd(largeur)}   wake ${m.reveil ?? `${table.reveil} (table rule)`}   added by ${borne(m.ajoute_par ?? "?")} ${m.ajoute_le}`);
  });
  if (enclos.length > 0) lignes.push(`  enclosed senders: ${enclos.map((e) => borne(e.expediteur)).join(", ")}`);
  process.stdout.write(`${lignes.join("\n")}\n`);
}

// Les commandes connues, leurs drapeaux et le nombre de mots qu'elles prennent
// (`null` : autant qu'on veut). Une commande inconnue, un drapeau qui ne
// s'applique pas, un mot de trop sont refusés AVANT d'ouvrir la base (2) —
// jamais ignorés : `valxos-table lister --fermee` ne doit pas avoir l'air d'un
// filtre qui a marché.
const COMMANDES = new Map([
  ["creer", { drapeaux: ["fermee", "reveil", "mode"], mots: 1 }],
  ["ajouter", { drapeaux: ["reveil"], mots: null }],
  ["retirer", { drapeaux: [], mots: null }],
  ["fermer", { drapeaux: [], mots: 1 }],
  ["ouvrir", { drapeaux: [], mots: 1 }],
  ["reveil", { drapeaux: ["membre"], mots: 2 }],
  ["mode", { drapeaux: [], mots: 2 }],
  ["position", { drapeaux: [], mots: null }],
  ["enclos", { drapeaux: ["retirer"], mots: 2 }],
  ["lister", { drapeaux: [], mots: 0 }],
  ["voir", { drapeaux: [], mots: 1 }]
]);

function usageDeLaCommande() {
  const regle = COMMANDES.get(commande);
  for (const drapeau of ["fermee", "retirer", "reveil", "mode", "membre"]) {
    if (args[drapeau] !== undefined && !regle.drapeaux.includes(drapeau)) {
      sortir(2, `--${drapeau} does not apply to ${commande}.\n\n${AIDE}`);
    }
  }
  const mots = commande === "enclos" && args.retirer === true ? 1 : regle.mots;
  if (mots !== null && args._.length - 1 > mots) {
    sortir(2, `Too many words for ${commande}: ${JSON.stringify(borne(args._.slice(1 + mots).join(" ")))}.\n\n${AIDE}`);
  }
}

function guichet() {
  if (!commande || commande === "aide" || args.help === true) {
    process.stdout.write(AIDE);
    return 0;
  }
  operateur = deriveSelfOuRefus("valxos-table");
  if (!COMMANDES.has(commande)) return sortir(2, `Unknown command: ${borne(commande)}\n\n${AIDE}`);
  usageDeLaCommande();

  const reveil = optionalArg(args, "reveil");
  const mode = optionalArg(args, "mode");

  if (commande === "creer") {
    const nom = nomDeTable(premier, "A name is required: valxos-table creer <name> [--fermee] [--reveil reveil|prochain-tour] [--mode normal|direct]");
    const regle = reveil === undefined ? "reveil" : regleDeReveil(reveil);
    const choix = mode === undefined ? "normal" : modeDeTable(mode);
    let table;
    try {
      // `fermee` est un BOOLÉEN pour le carnet : le drapeau, jamais une chaîne.
      table = creerTable(db(), { nom, fermee: args.fermee === true, reveil: regle, mode: choix, creeePar: operateur });
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: lisible(table) });
    else process.stdout.write(`Table "${nom}" created${Number(table.fermee) === 1 ? " (closed)" : ""}: wake ${table.reveil}, mode ${table.mode}.\n`);
    return 0;
  }

  // L'opérateur voit toutes les tables, fermées comprises : `listerTables` sans
  // adresses cache les fermées (c'est la règle des chaises), l'outil lit la table.
  if (commande === "lister") {
    const tables = db().prepare("SELECT * FROM tables ORDER BY nom").all();
    if (json) {
      printJson({ tables: tables.map((table) => ({ ...lisible(table), membres: membresDeTable(db(), table.nom).map((m) => ({ adresse: m.adresse, reveil: m.reveil })) })) });
    } else if (tables.length === 0) {
      process.stdout.write("No table yet:  valxos-table creer <name>\n");
    } else {
      const largeur = Math.max(...tables.map((table) => table.nom.length));
      const lignes = tables.map((table) => {
        const membres = membresDeTable(db(), table.nom);
        const position = positionCitee(table.position);
        return `  ${table.nom.padEnd(largeur)}   ${Number(table.fermee) === 1 ? "CLOSED" : "open  "}   wake ${table.reveil.padEnd(13)}   mode ${table.mode.padEnd(6)}   ${membres.length} member(s)${position ? `   position: ${position}` : ""}`;
      });
      process.stdout.write(`Tables\n\n${lignes.join("\n")}\n`);
    }
    return 0;
  }

  if (commande === "voir") {
    const nom = nomDeTable(premier, "A name is required: valxos-table voir <name>");
    try {
      montrerTable(tableExistante(nom));
    } catch (erreur) {
      return refuser(erreur);
    }
    return 0;
  }

  if (commande === "ajouter") {
    const nom = nomDeTable(premier, "A name and at least one address are required: valxos-table ajouter <name> <address>... [--reveil reveil|prochain-tour]");
    const adresses = reste.map(adresseDeMembre);
    if (adresses.length === 0) sortir(2, "At least one address is required: valxos-table ajouter <name> <address>...");
    const regle = reveil === undefined ? undefined : regleDeReveil(reveil);
    // Tout ou rien : une adresse refusée par le carnet n'en laisse pas une autre
    // à moitié ajoutée. `reveil` omis passe OMIS (`undefined`) : le carnet garde
    // alors la règle d'un membre qui revient ; un membre neuf suit la table.
    let ajoutes;
    try {
      ajoutes = db().transaction(() => adresses.map((adresse) => ajouterMembre(db(), nom, adresse, { reveil: regle, ajoutePar: operateur }).adresse))();
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: nom, ajoutes });
    else process.stdout.write(`${ajoutes.length} member(s) added to "${nom}": ${ajoutes.map((a) => borne(a)).join(", ")}${regle ? ` (wake ${regle})` : ""}.\n`);
    return 0;
  }

  if (commande === "retirer") {
    const nom = nomDeTable(premier, "A name and at least one address are required: valxos-table retirer <name> <address>...");
    const adresses = reste.map(adresseDeMembre);
    if (adresses.length === 0) sortir(2, "At least one address is required: valxos-table retirer <name> <address>...");
    // Tout ou rien, comme `ajouter` : un expéditeur enclos dans cette table
    // (`table-sous-enclos`) ne laisse pas les autres retirés à moitié.
    const retires = [];
    const absents = [];
    try {
      db().transaction(() => {
        tableExistante(nom);
        for (const adresse of adresses) (retirerMembre(db(), nom, adresse, { retirePar: operateur }) ? retires : absents).push(adresse);
      })();
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: nom, retires, absents });
    else {
      const lignes = [`${retires.length} member(s) withdrawn from "${nom}"${retires.length ? `: ${retires.map((a) => borne(a)).join(", ")}` : ""} (marked, not erased).`];
      if (absents.length > 0) lignes.push(`Not a member, nothing to withdraw: ${absents.map((a) => borne(a)).join(", ")}.`);
      process.stdout.write(`${lignes.join("\n")}\n`);
    }
    return 0;
  }

  if (commande === "fermer" || commande === "ouvrir") {
    const nom = nomDeTable(premier, `A name is required: valxos-table ${commande} <name>`);
    let table;
    try {
      // Rouvrir une table qui tient un enclos actif : le carnet refuse (`table-sous-enclos`).
      table = modifierTable(db(), nom, { fermee: commande === "fermer" });
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: lisible(table) });
    else process.stdout.write(commande === "fermer"
      ? `Table "${nom}" is closed: members move by this tool only, and its letters give no copy to another chair.\n`
      : `Table "${nom}" is open.\n`);
    return 0;
  }

  if (commande === "reveil") {
    const nom = nomDeTable(premier, "A name and a rule are required: valxos-table reveil <name> reveil|prochain-tour [--membre <address>]");
    if (reste[0] === undefined) sortir(2, "A rule is required: valxos-table reveil <name> reveil|prochain-tour [--membre <address>]");
    const regle = regleDeReveil(reste[0]);
    const membre = optionalArg(args, "membre");
    try {
      if (membre !== undefined) {
        // Le réglage d'UN membre ACTIF : `ajouterMembre` pose la règle sur un
        // membre actif sans toucher son cachet d'entrée — mais il ajouterait un
        // inconnu et réactiverait un retiré : on vérifie d'abord qu'il est
        // membre, dans la même transaction (comme `table_manage reveil`).
        const adresse = adresseDeMembre(membre);
        const ligne = db().transaction(() => {
          tableExistante(nom);
          if (!estMembre(db(), nom, [adresse])) {
            throw refus("pas-membre", `${JSON.stringify(borne(adresse))} is not an active member of table "${nom}": add it first (valxos-table ajouter)`);
          }
          return ajouterMembre(db(), nom, adresse, { reveil: regle, ajoutePar: operateur });
        })();
        if (json) printJson({ ok: true, table: nom, membre: { adresse: ligne.adresse, reveil: ligne.reveil } });
        else process.stdout.write(`Member ${borne(ligne.adresse)} of "${nom}" wakes: ${regle}.\n`);
        return 0;
      }
      const table = modifierTable(db(), nom, { reveil: regle });
      if (json) printJson({ ok: true, table: lisible(table) });
      else process.stdout.write(`Table "${nom}" wakes: ${regle}${regle === "prochain-tour" ? " (high and critical still wake; a member's own rule wins)" : ""}.\n`);
    } catch (erreur) {
      return refuser(erreur);
    }
    return 0;
  }

  if (commande === "mode") {
    const nom = nomDeTable(premier, "A name and a mode are required: valxos-table mode <name> normal|direct");
    if (reste[0] === undefined) sortir(2, "A mode is required: valxos-table mode <name> normal|direct");
    const choix = modeDeTable(reste[0]);
    let table;
    try {
      table = modifierTable(db(), nom, { mode: choix });
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: lisible(table) });
    else process.stdout.write(`Table "${nom}" mode: ${choix}${choix === "direct" ? " (a reply goes to the whole table and wakes nobody; the next beat wakes)" : ""}.\n`);
    return 0;
  }

  if (commande === "position") {
    const nom = nomDeTable(premier, "A name and a text are required: valxos-table position <name> <text>...");
    const texte = reste.join(" ").trim();
    if (!texte) sortir(2, "A text is required: valxos-table position <name> <text>...");
    let table;
    try {
      table = modifierTable(db(), nom, { position: texte, positionPar: operateur });
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, table: lisible(table) });
    else {
      const coupee = [...String(table.position ?? "")].length < [...texte].length;
      process.stdout.write(`Table "${nom}" position: ${positionCitee(table.position)}${coupee ? " (cut to 120 characters)" : ""}\n`);
    }
    return 0;
  }

  if (commande === "enclos") {
    // `enclos --retirer <sender>` : lever (marqué, jamais effacé) ; `enclos <sender> <name>` : poser.
    if (args.retirer === true) {
      if (premier === undefined) sortir(2, "A sender is required: valxos-table enclos --retirer <sender>");
      const expediteur = adresseDeMembre(premier);
      const retire = retirerEnclos(db(), expediteur, { retirePar: operateur });
      // N3 (re-revue du round 2) : lever l'enclos d'UNE forme ne libère pas un
      // expéditeur qu'une autre de ses formes tient encore — on le dit, et qui.
      // R3 (re-revue du round 3) : « tient encore » se calcule pour CET
      // expéditeur (`enclosQuiTiennent`) ; deux chaises sœurs sont deux
      // expéditeurs (S9), et l'enclos d'une sœur se dit à part.
      const enDeux = (liste) => liste.map((e) => ({ expediteur: e.expediteur, table: e.nom_table }));
      const encore = enDeux(enclosQuiTiennent(db(), expediteur));
      const autres = enDeux(enclosDesAutresFormes(db(), expediteur))
        .filter((e) => !encore.some((tenant) => tenant.expediteur === e.expediteur));
      const dire = (liste) => liste.map((e) => `${JSON.stringify(borne(e.expediteur))} in table "${e.table}"`).join(" and ");
      const tenu = encore.map((e) => `by ${JSON.stringify(borne(e.expediteur))} in table "${e.table}"`).join(" and ");
      const voisins = autres.length > 0 ? ` Another sender of its lineage is still enclosed: ${dire(autres)}.` : "";
      if (json) printJson({ ok: true, expediteur, retire, encore_enclos: encore, autres_enclos_de_la_lignee: autres });
      else if (retire) {
        process.stdout.write(encore.length > 0
          ? `Enclosure of ${JSON.stringify(borne(expediteur))} lifted for this form; the sender is still enclosed ${tenu}.${voisins}\n`
          : `Enclosure of ${JSON.stringify(borne(expediteur))} lifted: it writes to anyone again.${voisins}\n`);
      } else {
        process.stdout.write(`No enclosure for ${JSON.stringify(borne(expediteur))}: nothing to lift.${encore.length > 0 ? ` The sender is still enclosed ${tenu}.` : ""}${voisins}\n`);
      }
      return 0;
    }
    if (premier === undefined || reste[0] === undefined) {
      sortir(2, "A sender and a CLOSED table are required: valxos-table enclos <sender> <name>  (or: enclos --retirer <sender>)");
    }
    // L'expéditeur passe tel qu'écrit dans la table : le carnet compare la forme
    // écrite (`pas-membre` si la table liste `alice` et qu'on enferme `alice#s-1`).
    const expediteur = adresseDeMembre(premier);
    const nom = nomDeTable(reste[0], "A table name is required: valxos-table enclos <sender> <name>");
    let enclos;
    try {
      enclos = poserEnclos(db(), expediteur, nom, { posePar: operateur });
    } catch (erreur) {
      return refuser(erreur);
    }
    if (json) printJson({ ok: true, enclos });
    else process.stdout.write(`${JSON.stringify(borne(expediteur))} is enclosed in "${nom}": its letters go to this table's members only (--hors-enclos lets one out).\n`);
    return 0;
  }

  // Jamais atteint (COMMANDES est la loi) : gardé comme filet.
  return sortir(2, `Unknown command: ${borne(commande)}\n\n${AIDE}`);
}

await executer(guichet);
