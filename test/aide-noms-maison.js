// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LA MÉCANIQUE DU DÉTECTEUR DES NOMS DE LA MAISON — ET AUCUN NOM.
//
// Ce fichier sait CHERCHER des noms (frontières de mot, casse, forme tronquée,
// nom versionné, haché de commit) ; il n'en connaît AUCUN. Les noms viennent de
// l'appelant :
//   - test/surfaces.test.js l'exerce sur des noms FICTIFS écrits en clair
//     (`zz-agent-fictif`, `.claude-zz`…) : la mécanique se prouve en public ;
//   - test/noms-prives.test.js, qui reste hors du miroir public, lui donne la
//     liste réelle des auteurs.
// Un détecteur dont la liste vivrait dans l'arbre public publierait ce qu'il
// interdit (verdict du 18/10/2026 : une liste encodée reste réversible). Un
// détecteur dont la mécanique n'est pas prouvée ne garde rien. D'où la coupure :
// la mécanique ici, la liste là-bas.
import fs from "node:fs";
import path from "node:path";

export const ECHAPPE = (mot) => mot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Les lignées d'EXEMPLE portent le suffixe de lignée sans rien révéler
// (ruling du 18/10 : c'est une forme, pas un nom) ; toute autre adresse qui le
// porte est une adresse vivante des auteurs.
export const LIGNEES_D_EXEMPLE = ["alice", "bob"];

export const motsAvecFrontieres = (mots, flags = "i") => new RegExp(`\\b(?:${mots.map(ECHAPPE).join("|")})\\b`, flags);

export const HACHE_NU = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/;

// Dans test/, les identifiants de session des fixtures ont la forme d'un UUID
// (`<8 hex>-<4 hex>-…`) ou d'un préfixe cité (`"<8 hex>"`, ce qu'on passe à
// `valxos-chaise designer`). Mesuré le 18/10 sur test/ : la règle du paquet y
// accusait environ 70 fixtures pour 10 vrais hachés. Dans test/, un haché nu
// n'est donc compté que hors d'une chaîne citée et hors d'un UUID : ni
// guillemet, ni tiret, ni `#`/`@` collé à lui. Même mesure avec cette règle :
// les 10 vrais hachés, aucune fixture.
export const HACHE_NU_HORS_FIXTURE = /(?<![\w"'`#@-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}(?![\w"'`-])/;

// La forme de `noms`, lue champ par champ :
//   agents      deux noms d'agent ; `tronque` est un préfixe du SECOND
//   tronque     la forme tronquée du second nom d'agent
//   instances   deux noms d'instance
//   surnom      un surnom
//   lignee      le suffixe d'adresse de lignée (`<nom>-<lignee>`)
//   relecteurs  un nom de relecteur et sa forme en capitales
//   modeles     deux noms de modèles relecteurs
//   maisons     les suffixes des maisons (`.claude-<suffixe>`)
//   role        le rôle d'orchestrateur
//
// Trois formes que la revue du 18/10 a trouvées vivantes après le premier
// passage, chacune avec sa règle :
// - le relecteur EN CAPITALES (un titre de commentaire) : sa forme capitale
//   est un second motif, sensible à la casse comme le premier. Le motif ne
//   devient PAS insensible à la casse : en minuscules, le même mot peut être un
//   nom commun français (cinq emplois mesurés le 18/10 sur l'arbre suivi, dont
//   deux dans le paquet).
// - la forme TRONQUÉE du second nom d'agent (un ancien nom court) : le préfixe
//   compte seul, suivi de n'importe quoi sauf la fin du nom entier, que le
//   motif d'agent compte déjà.
// - le modèle relecteur VERSIONNÉ (le nom collé à son numéro, sans frontière
//   de mot entre les deux) : le nom compte dès qu'un chiffre le suit.
export function motifsDesNoms(noms, ligneesDExemple = LIGNEES_D_EXEMPLE) {
  const [, agentTronque] = noms.agents;
  const finDuNom = agentTronque.slice(noms.tronque.length);
  return [
    ...noms.agents.map((mot) => [motsAvecFrontieres([mot]), "un nom d'agent"]),
    [new RegExp(`\\b${ECHAPPE(noms.tronque)}(?!${ECHAPPE(finDuNom)}\\b)`, "i"), "un nom d'agent tronqué"],
    ...noms.instances.map((mot) => [new RegExp(ECHAPPE(mot), "i"), "un nom d'instance"]),
    [new RegExp(ECHAPPE(noms.surnom), "i"), "un surnom"],
    [new RegExp(`(?<!\\b(?:${ligneesDExemple.join("|")}))-${ECHAPPE(noms.lignee)}`, "i"), "une adresse de lignée"],
    ...noms.relecteurs.map((mot) => [motsAvecFrontieres([mot], ""), "un nom de relecteur"]),
    [motsAvecFrontieres([noms.modeles[0]]), "un nom de modèle relecteur"],
    [new RegExp(`\\b${ECHAPPE(noms.modeles[0])}(?=\\d)`, "i"), "un nom de modèle relecteur versionné"],
    [new RegExp(ECHAPPE(noms.modeles[1]), "i"), "un nom de modèle relecteur"],
    [new RegExp(`\\.claude-(?:${noms.maisons.map(ECHAPPE).join("|")})`, "i"), "une maison"],
    [motsAvecFrontieres([noms.role]), "un rôle d'orchestrateur"],
    [/\bcommit [0-9a-f]{7}/i, "un commit de l'historique privé"],
    // Un haché sans le mot « commit » devant (`facteur.js/<haché>`) : 7 à 12
    // chiffres hexadécimaux, au moins une lettre et un chiffre. Mesuré sur le
    // paquet du 18/10 : treize vrais hachés, aucun faux positif.
    [HACHE_NU, "un haché de l'historique privé"]
  ];
}

// Les mêmes motifs pour les fichiers de test/ : seul le haché nu change.
export function motifsDansTest(motifs) {
  return motifs.map(([motif, quoi]) => [motif === HACHE_NU ? HACHE_NU_HORS_FIXTURE : motif, quoi]);
}

// Une ligne par motif trouvé : { ligne, motif (la source), quoi, extrait }.
export function nomsDeLaMaison(texte, motifs) {
  const trouves = [];
  texte.split("\n").forEach((ligne, i) => {
    for (const [motif, quoi] of motifs) {
      if (motif.test(ligne)) trouves.push({ ligne: i + 1, motif: motif.source, quoi, extrait: ligne.trim().slice(0, 90) });
    }
  });
  return trouves;
}

// Le balayage de fichiers : `fichiers` sont des chemins relatifs à `racine`.
// `exceptions` : { fichier, motif: <la source de la regex>, test: <le test qui
// l'exige> } ; seuls `fichier` et `motif` sont lus ici.
export function fautesDansLesFichiers({ racine, fichiers, motifs, exceptions = [] }) {
  const fautes = [];
  for (const rel of fichiers) {
    for (const { ligne, motif, quoi, extrait } of nomsDeLaMaison(fs.readFileSync(path.join(racine, rel), "utf8"), motifs)) {
      if (exceptions.some((e) => e.fichier === rel && e.motif === motif)) continue;
      fautes.push(`${rel}:${ligne} : ${quoi} — « ${extrait} »`);
    }
  }
  return fautes;
}

// UN NOM D'AGENT EN DUR COMME DESTINATAIRE (27/09). Une lignée écrivait au vieux
// nom court d'une autre lignée au lieu de son adresse de lignée, et les lettres
// dormaient dans une fiche morte. L'alias vit au REGISTRE (valxos-chaise
// alias), jamais dans le produit : aucun défaut, aucun repli, aucun exemple,
// aucune fixture publiée ne nomme un nom d'agent en dur comme destination. Les
// vieux noms courts sont les noms d'agent (et la forme `claude-<agent>`).
export function motifAdresseEnDur(agents) {
  const vieuxNomsCourts = [...agents, `claude-${agents[0]}`].map(ECHAPPE);
  return new RegExp(
    `["'\`](${vieuxNomsCourts.join("|")})([#@][^"'\`\\s]*)?["'\`]` +
    `|(--to[= ]|\\bto: ?|\\brecipient: ?)(${vieuxNomsCourts.join("|")})(?![\\w-])`
  );
}

// Les numéros de ligne fautifs ; une ligne de commentaire a le droit de raconter.
export function lignesFautives(texte, motifAdresse) {
  const fautives = [];
  texte.split("\n").forEach((l, i) => {
    if (/^\s*(\/\/|#|\*)/.test(l)) return;
    if (motifAdresse.test(l)) fautives.push(i + 1);
  });
  return fautives;
}
