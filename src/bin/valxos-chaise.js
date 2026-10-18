#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// La chaise : le seul geste humain du design.
//
// Une lignée à plusieurs sessions vivantes ne se tranche jamais toute seule — le
// courrier ATTEND jusqu'à ce que quelqu'un dise à quelle chaise il va. Sans cet
// outil, ce « quelqu'un » n'avait aucune porte : la lignée restait ambiguë et le
// courrier attendait pour toujours.
//
// Cet outil ne touche JAMAIS au courrier : il ne lit pas les lettres, il n'en
// affiche aucune, il n'en marque aucune. Ses seuls effets possibles sont des
// écritures de registre : désigner une chaise (`designer`), la libérer
// (`liberer`), déposer un renvoi d'ancien nom (`reexpedier`), poser un alias
// prioritaire (`alias`), marquer mortes les chaises sans processus
// (`moissonner`, Run 6 Task 8 — rien ne s'efface).
import { getDatabase } from "../lib/database.js";
import {
  SEPARATEUR_SESSION,
  STATUTS_HORS_SERVICE,
  deposerAncienNom,
  designatePrimary,
  libelleStatut,
  listInstances,
  listLineages,
  listerAnciensNoms,
  poserAlias,
  reapDeadPeers,
  resolveRecipient,
  trouverChaise,
  undesignate
} from "../lib/registry.js";
import { executer, parseArgs, printJson, sortir } from "./cli-common.js";

const AIDE = `valxos-chaise — who receives a lineage's mail

  valxos-chaise lignees                    the living lineages and their state
  valxos-chaise chaises <lineage>          a lineage's chairs, and the designated one
  valxos-chaise designer <lineage> <chair> give the chair (whole session id or its start)
  valxos-chaise liberer <lineage>          take the chair back: the lineage is ambiguous again

  valxos-chaise anciens-noms               the forwarding records already posted
  valxos-chaise reexpedier <old> <lineage> forward the mail of a dead name
  valxos-chaise alias <name> <lineage>     an old name that no card masks
                                          (--force for a name that still has chairs,
                                          or that carries past letters)

  valxos-chaise moissonner                 harvest: mark chairs without a process dead (nothing is erased)

  --json                                  the same, for machines

A lineage with several chairs and no designation is AMBIGUOUS: its mail
waits. This is deliberate: a letter read by the wrong reader cannot be taken back.

Nothing is lost here, not even a name: an old name keeps pointing to the same
lineage, and resolves EXACTLY like it.
`;

// UNE SEULE SORTIE : le guichet est UNE fonction qui rend un code (`return`
// après chaque commande), `sortir()` LÈVE au lieu de rendre la main, et
// `executer()` sort une fois, après le drain de stdout et stderr. Le patron
// et son histoire (Task 8, fix round 1 : l'aide qui tombait jusqu'à
// « Commande inconnue ») vivent dans cli-common.js.

// ── UN RENVOI SERT-IL, OUI OU NON ? ─────────────────────────────────────────
//
// La colonne d'état ne suffit pas, et c'est le piège qui fait rater une
// cérémonie en silence : un renvoi qui SERT et un renvoi masqué par une fiche
// héritée valent tous les deux `instance` au guichet. Ce qui les sépare, c'est
// que le guichet NOMME la réexpédition quand elle a servi (`reexpedie`). Sans
// ce nom, l'ancien nom a répondu tout seul : le renvoi est inerte.
//
// Deux façons d'être masqué, et elles n'appellent pas le même geste :
//   · une CHAISE VIVANTE porte encore le nom → le renvoi attendra qu'elle parte,
//     c'est normal et ça se règle tout seul ;
//   · une FICHE HÉRITÉE (Camp B, sans session) le porte → elle ne s'éteindra
//     JAMAIS toute seule. Il faut la retirer du service, et l'outil doit le dire.
function etatDuRenvoi(db, ancienNom) {
  const resolution = resolveRecipient(db, ancienNom);
  if (resolution.reexpedie) {
    return { sert: true, mene_a: resolution.reexpedie, masque_par: null };
  }
  // Un ALIAS ne se masque jamais : il sert dès que quelqu'un répond au bout,
  // et sinon personne n'est au bout — ce n'est jamais une fiche qui le masque.
  if (resolution.alias) {
    return resolution.kind === "unknown"
      ? { sert: false, mene_a: null, masque_par: null }
      : { sert: true, mene_a: resolution.alias, masque_par: null };
  }
  if (resolution.kind === "unknown") {
    return { sert: false, mene_a: null, masque_par: null };
  }
  const vivantes = resolution.targets.filter((c) => c.instance_session_id);
  return {
    sert: false,
    mene_a: null,
    masque_par: vivantes.length > 0 ? "chaise-vivante" : "fiche-heritee"
  };
}

// La phrase qui dit à l'humain ce qu'il doit faire, ou rien s'il n'y a rien à
// faire. Un diagnostic sans remède se lit comme une fatalité.
function remedeDuRenvoi(ancienNom, etat) {
  if (etat.masque_par === "fiche-heritee") {
    return `INERT: a legacy card still carries "${ancienNom}", and it will never leave service on its own.\n` +
      `   The remedy:  valxos-unregister --id ${ancienNom}`;
  }
  if (etat.masque_par === "chaise-vivante") {
    return `INERT: a LIVE chair still carries this name, so the mail of "${ancienNom}" is its own.\n` +
      `   The forwarding will serve when that chair leaves service. Nothing to do.`;
  }
  if (!etat.sert) {
    return `Nobody at the other end: no chair in service answers for "${ancienNom}".`;
  }
  return null;
}

// L'adresse humaine d'une chaise, celle que l'humain tape : `lignée@nom`.
// Sans nom lu dans la fiche de session, il n'y en a pas — on n'en invente pas.
function adresseHumaine(chaise) {
  if (!chaise.lineage || !chaise.session_name) return null;
  return `${chaise.lineage}${SEPARATEUR_SESSION}${chaise.session_name}`;
}

function ligneDeChaise(chaise, designee) {
  const marque = designee ? "▸" : " ";
  const suffixe = designee ? "   ← DESIGNATED" : "";
  const maison = chaise.house || "house unknown";
  const pid = chaise.pid == null ? "pid ?" : `pid ${chaise.pid}`;
  const vu = chaise.heartbeat_at || chaise.last_seen;
  const vue = vu ? `seen ${vu}` : "never seen";
  // La même notion de service que le routage (EN_SERVICE) : `offline` est le
  // geste humain, `dead` le constat de la moisson — les deux se DISENT.
  const service = chaise.status === "dead" ? "  [dead]"
    : STATUTS_HORS_SERVICE.includes(String(chaise.status || "")) ? "  [out of service]" : "";
  // L'adresse se montre ENTIÈRE : une adresse qu'on ne voit nulle part ne se
  // tape jamais, et c'était tout le problème de l'identifiant technique.
  const adresse = adresseHumaine(chaise);
  const nom = adresse ? `   ${adresse}` : "";
  return `  ${marque} ${chaise.instance_session_id}${nom}   ${pid}   ${maison}   ${vue}${service}${suffixe}`;
}

function montrerLignee(db, lignee, json) {
  const chaises = listInstances(db, lignee, { includeOffline: true });
  const enService = chaises.filter((c) => !STATUTS_HORS_SERVICE.includes(String(c.status || "")));
  const resolution = resolveRecipient(db, lignee);
  const designee = enService.find((c) => Number(c.is_primary) === 1) || null;

  const anciens = listerAnciensNoms(db, { lignee });

  if (json) {
    printJson({
      lignee,
      resolution: resolution.kind,
      designee: designee?.instance_session_id || null,
      designee_morte: resolution.designee_morte || null,
      anciens_noms: anciens.map((r) => r.ancien_nom),
      chaises: chaises.map((c) => ({
        session: c.instance_session_id,
        chaise: c.id,
        nom: c.session_name || null,
        adresse: adresseHumaine(c),
        maison: c.house || null,
        pid: c.pid,
        statut: c.status,
        vue: c.heartbeat_at || c.last_seen,
        designee: Number(c.is_primary) === 1
      }))
    });
    return;
  }

  if (chaises.length === 0) {
    process.stdout.write(`Lineage "${lignee}": no chair.\n`);
    return;
  }
  const lignes = [`Lineage "${lignee}": ${enService.length} chair(s) in service`, ""];
  // I-5 (vérification des chaises parallèles, 18/10) : la flèche suit le
  // ROUTAGE, pas `is_primary` seul. Après une moisson, la désignée morte garde
  // sa marque en base ; la ligne la disait encore « DÉSIGNÉE » juste au-dessus
  // d'un pied qui disait le routage réel (une seule chaise en service, sans
  // désignation). Une chaise se dit désignée quand elle l'est ET que le
  // guichet lui mène le courrier de la lignée.
  const recoit = resolution.kind === "lineage" && resolution.targets.length === 1 ? resolution.targets[0].id : null;
  for (const chaise of chaises) {
    lignes.push(ligneDeChaise(chaise, Number(chaise.is_primary) === 1 && chaise.id === recoit));
  }
  lignes.push("");
  if (anciens.length > 0) {
    lignes.push(`Old names that lead here: ${anciens.map((r) => r.ancien_nom).join(", ")}`);
    lignes.push("");
  }
  if (resolution.kind === "ambigu") {
    if (resolution.designee_morte) {
      const morte = resolution.designee_morte;
      const depuis = morte.depuis ? ` since ${morte.depuis}` : "";
      lignes.push(`The designated chair ${morte.session} is ${libelleStatut(morte.statut)}${depuis}.`);
      lignes.push(`Mail addressed to "${lignee}" WAITS for a RE-designation:  valxos-chaise designer ${lignee} <session start>`);
      lignes.push("Or, if a single live chair remains, harvest the dead ones and the mail goes to it:  valxos-chaise moissonner");
    } else {
      lignes.push(`Mail addressed to "${lignee}" WAITS: nobody holds the chair.`);
      lignes.push(`To decide:  valxos-chaise designer ${lignee} <session start>`);
      lignes.push("Or, if only one of these chairs is still alive, harvest the dead ones and the mail goes to it:  valxos-chaise moissonner");
    }
  } else if (designee && designee.id === recoit) {
    lignes.push(`Mail addressed to "${lignee}" goes to ${designee.instance_session_id}.`);
  } else if (resolution.kind === "lineage") {
    lignes.push(`One chair in service: the mail of "${lignee}" goes to it without a designation.`);
  } else {
    lignes.push(`No chair in service: mail addressed to "${lignee}" waits.`);
  }
  process.stdout.write(`${lignes.join("\n")}\n`);
}

// --json/--help déclarés BOOLÉENS (revue adverse, en construisant la carte de
// couverture parseArgs — même classe qu'une régression antérieure de facteur.js,
// invisible ici jusque-là parce que tous les tests et docs mettent --json en
// DERNIER). Sans ça, `cc2cc-chaise --json lignees` lisait "lignees" comme la
// VALEUR de --json (une chaîne, jamais true) : commande devenait undefined,
// et le guichet imprimait l'AIDE avec exit 0 au lieu du JSON demandé — un
// échec BRUYANT (rien de silencieusement faux, pas de courrier déplacé),
// contrairement au démon sans borne de facteur.js — c'est pour ça que ce
// trou est resté BAS plutôt qu'IMPORTANT, mais un trou quand même.
const args = parseArgs(process.argv.slice(2), {
  booleans: ["json", "help", "force"],
  known: [],
  // `-h` et `--help` sont le MÊME geste : l'aide complète, la liste des commandes.
  // `usage` était une ligne qui renvoyait à `--help` — deux aides pour un geste
  // (Q11, revue qualité, 18/10). Un drapeau inconnu l'imprime aussi, après son refus.
  usage: AIDE
});
const [commande, lignee, chaiseVoulue] = args._;
const json = args.json === true;

function guichet() {
  if (!commande || commande === "aide" || args.help === true) {
    process.stdout.write(AIDE);
    return 0;
  }

  const db = getDatabase();

  if (commande === "lignees") {
    const lignees = listLineages(db);
    if (json) {
      printJson({ lignees });
    } else if (lignees.length === 0) {
      process.stdout.write("No lineage has a chair in service.\n");
    } else {
      const largeur = Math.max(...lignees.map((l) => l.lineage.length));
      const lignes = lignees.map((l) => {
        const etat = l.kind === "ambigu"
          ? l.designee_morte
            ? "AMBIGUOUS: designated chair dead, re-designate or harvest"
            : "AMBIGUOUS: mail waits"
          : l.designee
            ? `designated: ${l.designee}`
            : "one chair";
        return `  ${l.lineage.padEnd(largeur)}   ${String(l.chaises).padStart(2)} chair(s)   ${etat}`;
      });
      process.stdout.write(`Living lineages\n\n${lignes.join("\n")}\n`);
    }
    return 0;
  }

  if (commande === "chaises") {
    if (!lignee) sortir(2, "A lineage is required: valxos-chaise chaises <lineage>");
    montrerLignee(db, lignee, json);
    return 0;
  }

  if (commande === "designer") {
    if (!lignee || !chaiseVoulue) {
      sortir(2, "A lineage and a chair are required: valxos-chaise designer <lineage> <chair>");
    }
    let chaise;
    try {
      chaise = trouverChaise(db, lignee, chaiseVoulue);
    } catch (erreur) {
      sortir(1, `Nothing was designated: ${erreur.message}`);
    }
    if (STATUTS_HORS_SERVICE.includes(String(chaise.status || ""))) {
      sortir(1, `Nothing was designated: chair ${chaise.instance_session_id} is out of service (${chaise.status}).`);
    }
    designatePrimary(db, lignee, chaise.instance_session_id);
    if (json) {
      printJson({ designee: true, lignee, session: chaise.instance_session_id, chaise: chaise.id });
    } else {
      process.stdout.write(`The chair of "${lignee}" is now ${chaise.instance_session_id}.\n\n`);
      montrerLignee(db, lignee, false);
    }
    return 0;
  }

  // `anciens-noms` est le PRÉ-VOL : avant d'attendre une lettre venue d'un nom
  // mort, on vient voir ici si le renvoi sert vraiment. Il ne suffit donc pas
  // d'afficher le verdict du guichet — il faut dire s'il a SERVI.
  if (commande === "anciens-noms") {
    const renvois = listerAnciensNoms(db);
    if (json) {
      printJson({
        anciens_noms: renvois.map((r) => {
          const etat = etatDuRenvoi(db, r.ancien_nom);
          return {
            ancien_nom: r.ancien_nom,
            lignee: r.lignee,
            note: r.note || null,
            depose_at: r.depose_at,
            resolution: resolveRecipient(db, r.ancien_nom).kind,
            alias: Number(r.prioritaire) === 1,
            // Ce que la colonne d'état ne dit pas : ce renvoi sert-il, et sinon,
            // qui le masque.
            sert: etat.sert,
            mene_a: etat.mene_a,
            masque_par: etat.masque_par
          };
        })
      });
    } else if (renvois.length === 0) {
      process.stdout.write("No forwarding record in the registry.\n");
    } else {
      const largeur = Math.max(...renvois.map((r) => r.ancien_nom.length));
      const lignes = [];
      for (const r of renvois) {
        const etat = etatDuRenvoi(db, r.ancien_nom);
        const kind = resolveRecipient(db, r.ancien_nom).kind;
        const note = r.note ? `   "${r.note}"` : "";
        const verdict = etat.sert ? `leads to ${etat.mene_a}` : "NOT SERVING";
        const marque = Number(r.prioritaire) === 1 ? "   ALIAS" : "";
        lignes.push(
          `  ${r.ancien_nom.padEnd(largeur)} → ${r.lignee}   [${kind}]${marque}   ${verdict}   posted ${r.depose_at}${note}`
        );
        const remede = remedeDuRenvoi(r.ancien_nom, etat);
        if (remede) lignes.push(`      ${remede.split("\n").join("\n      ")}`);
      }
      process.stdout.write(`Forwarding records\n\n${lignes.join("\n")}\n`);
    }
    return 0;
  }

  // `reexpedier <ancien> <lignée>` — le geste qui fait qu'un nom mort continue de
  // mener à sa famille. Il n'écrit RIEN d'autre qu'une ligne de registre : aucun
  // courrier n'est touché, aucune lettre n'est relue.
  if (commande === "reexpedier") {
    const [, ancienNom, versLignee] = args._;
    if (!ancienNom || !versLignee) {
      sortir(2, "An old name and a lineage are required: valxos-chaise reexpedier <old> <lineage>");
    }
    // Ce que le guichet répondait AVANT le dépôt : c'est la seule façon honnête de
    // dire à l'humain si son renvoi servira à quelque chose.
    const avant = resolveRecipient(db, ancienNom);
    let pose;
    try {
      pose = deposerAncienNom(db, ancienNom, versLignee);
    } catch (erreur) {
      sortir(1, `Nothing was posted: ${erreur.message}`);
    }
    const apres = resolveRecipient(db, ancienNom);
    const masque = avant.kind !== "unknown";
    const etat = etatDuRenvoi(db, ancienNom);
    if (json) {
      printJson({
        reexpedie: true,
        ancien_nom: pose.ancien_nom,
        lignee: pose.lignee,
        depose_at: pose.depose_at,
        resolution: apres.kind,
        porte_encore_ce_nom: masque,
        sert: etat.sert,
        mene_a: etat.mene_a,
        masque_par: etat.masque_par
      });
    } else {
      const lignes = [`The mail of "${pose.ancien_nom}" now follows "${pose.lignee}".`];
      // On ne ment pas à l'humain, et on ne le laisse pas non plus avec un
      // diagnostic sans remède : « le renvoi ne servira pas tant qu'alice
      // répond » décrit un vivant, alors qu'une fiche héritée est un fantôme qui
      // ne répondra plus jamais et ne s'éteindra jamais seul.
      const remede = remedeDuRenvoi(pose.ancien_nom, etat);
      if (remede) {
        lignes.push("");
        lignes.push(`⚠️  ${remede}`);
      }
      lignes.push("");
      lignes.push(`The office now resolves "${pose.ancien_nom}" as: ${apres.kind}.`);
      process.stdout.write(`${lignes.join("\n")}\n`);
    }
    return 0;
  }

  // `alias <nom> <lignée>` — le renvoi qu'AUCUN vivant ne masque (27/09). Un
  // renvoi ordinaire cède devant quiconque porte encore l'ancien nom ; un alias
  // passe devant tout le monde : fiche héritée, chaise vivante, adresse humaine.
  // C'est donc un geste plus fort, et il a sa garde : aliaser un nom qui est
  // encore une LIGNÉE AVEC DES CHAISES, c'est détourner le courrier de sessions
  // vivantes. Ça se fait, mais seulement en le disant (`--force`).
  if (commande === "alias") {
    const [, nom, versLignee] = args._;
    if (!nom || !versLignee) {
      sortir(2, "A name and a lineage are required: valxos-chaise alias <name> <lineage>");
    }
    const force = args.force === true;
    const chaisesDuNom = listInstances(db, String(nom).trim());
    if (chaisesDuNom.length > 0 && !force) {
      sortir(
        1,
        `Nothing was posted: "${nom}" is a living lineage with ${chaisesDuNom.length} chair(s) in service ` +
          `(${chaisesDuNom.map((c) => c.instance_session_id).join(", ")}).\n` +
          `   An alias would take their mail. If that is intended:  valxos-chaise alias ${nom} ${versLignee} --force`
      );
    }
    // LE PASSÉ DU NOM SE DIT (F8, passe adverse, 28/09) : un alias donne à la
    // lignée d'arrivée le nom, et la correspondance que le nom avait eue avec
    // des tiers. L'historique est borné au dépôt (database.js `history`) ;
    // aliaser un nom qui porte des lettres passées se fait quand même, mais
    // seulement en le disant (`--force`).
    const lettresPassees = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE sender = ? OR recipient = ?")
      .get(String(nom).trim(), String(nom).trim()).n;
    if (lettresPassees > 0 && !force) {
      sortir(
        1,
        `Nothing was posted: "${nom}" carries ${lettresPassees} past letter(s) (sent or received under this name).\n` +
          `   The alias will not make them readable to "${versLignee}" (history starts at the alias), but it takes the name.\n` +
          `   If that is intended:  valxos-chaise alias ${nom} ${versLignee} --force`
      );
    }
    const avant = resolveRecipient(db, nom);
    let pose;
    try {
      pose = poserAlias(db, nom, versLignee);
    } catch (erreur) {
      sortir(1, `Nothing was posted: ${erreur.message}`);
    }
    const apres = resolveRecipient(db, nom);
    const masquait = avant.kind !== "unknown" && !avant.alias ? avant.targets.map((c) => c.id) : [];
    if (json) {
      printJson({
        alias: true,
        nom: pose.ancien_nom,
        lignee: pose.lignee,
        depose_at: pose.depose_at,
        resolution: apres.kind,
        mene_a: apres.targets.map((c) => c.id),
        masquait,
        chaises_detournees: chaisesDuNom.map((c) => c.instance_session_id),
        lettres_passees: lettresPassees,
        force
      });
    } else {
      const lignes = [`"${pose.ancien_nom}" is now an alias of "${pose.lignee}": no card masks it.`];
      if (lettresPassees > 0) {
        lignes.push(`This name carried ${lettresPassees} past letter(s): the history under "${pose.ancien_nom}" returns only the letters posted after this alias.`);
      }
      if (masquait.length > 0) {
        lignes.push(`Before, this name led to: ${masquait.join(", ")}. Their mail addressed to "${pose.ancien_nom}" follows the alias.`);
      }
      lignes.push("");
      lignes.push(
        apres.kind === "unknown"
          ? `The office resolves "${pose.ancien_nom}" as: unknown. The mail is HELD for "${pose.lignee}" until a chair announces itself there.`
          : `The office now resolves "${pose.ancien_nom}" as: ${apres.kind} (${apres.targets.map((c) => c.id).join(", ")}).`
      );
      process.stdout.write(`${lignes.join("\n")}\n`);
    }
    return 0;
  }

  // `moissonner` — le second geste explicite qui marque des chaises mortes (le
  // premier est `valxos-doctor --reap`). Le doctor, lui, ne fait que constater ;
  // les hooks et le Facteur ne moissonnent jamais (Task 6). Une chaise marquée
  // `dead` garde sa ligne : rien ne s'efface.
  if (commande === "moissonner") {
    const r = reapDeadPeers(db);
    if (json) {
      printJson({ moissonnees: r.reaped, abstenues: r.abstained, chaises: r.moissonnees });
    } else if (r.reaped === 0 && r.abstained === 0) {
      process.stdout.write(`No chair without a process (${r.checked} checked).\n`);
    } else {
      const lignes = r.moissonnees.map((c) => `  dead    ${c.id}   pid ${c.pid ?? "?"}   ${c.raison}`);
      for (const c of r.abstenues) lignes.push(`  ?       ${c.id}   pid ${c.pid ?? "?"}   ${c.raison} (undecided, left in service)`);
      process.stdout.write(`${r.reaped} chair(s) marked dead, ${r.abstained} undecided\n\n${lignes.join("\n")}\n`);
    }
    return 0;
  }

  if (commande === "liberer") {
    if (!lignee) sortir(2, "A lineage is required: valxos-chaise liberer <lineage>");
    const rendues = undesignate(db, lignee);
    if (json) {
      printJson({ liberee: true, lignee, chaises_touchees: rendues });
    } else {
      process.stdout.write(`The chair of "${lignee}" is free (${rendues} card(s) touched).\n\n`);
      montrerLignee(db, lignee, false);
    }
    return 0;
  }

  return sortir(2, `Unknown command: ${commande}\n\n${AIDE}`);
}

await executer(guichet);
