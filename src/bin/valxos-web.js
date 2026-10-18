#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE LANCEUR DE LA PORTE WEB — `valxos-web` (`cc2cc-web` reste un alias).
//
// Il ne fait que quatre choses, dans cet ORDRE, et l'ordre est la garde :
//   ⓪ lire sa ligne de commande — `-h`/`--help` imprime l'usage et sort 0, un
//     drapeau ou un mot inconnu sort 2 — AVANT de lire `web.env`, l'opérateur ou
//     quoi que ce soit : `valxos-web --help` ouvrait la porte dès qu'un
//     opérateur était posé (revue finale, 18/10).
//   ① vérifier l'adresse d'écoute — AVANT d'ouvrir quoi que ce soit. Un refus
//     qui a déjà posé un bureau (ou un verrou) n'est qu'un demi-refus : c'est
//     la leçon du démon sous garde (un correctif antérieur, historique privé),
//     et elle vaut ici.
//   ② charger le jeton (`~/.valxos-messenger/web.env`, 0600) — jamais l'afficher.
//   ③ ouvrir la porte sur la boucle locale.
//
// Toute exposition éventuelle se traite en amont : ce processus n'écoute
// JAMAIS ailleurs que sur la boucle locale.
import { getDatabase } from "../lib/database.js";
import { chargerLeJeton, fichierDuJeton, reglagesDeLaPorte } from "../web/auth.js";
import { ouvrirLaPorte, verifierLHote } from "../web/serveur.js";
import { parseArgs } from "./cli-args.js";

// ⓪ LA LIGNE DE COMMANDE D'ABORD. Aucun drapeau n'est déclaré : la porte se règle
// par `web.env` et par l'environnement, jamais par la ligne de commande.
parseArgs(process.argv.slice(2), {
  known: [],
  positionals: false,
  usage:
    "valxos-web — serve the local web door (loopback only). " +
    "Configuration: ~/.valxos-messenger/web.env (VALXOS_WEB_OPERATEUR required). Flags: -h, --help."
});

// ⚠️ LES RÉGLAGES VIENNENT DE `web.env` AUTANT QUE DE L'ENV — le fichier est le
// seul endroit prévu pour régler la porte, et le lanceur n'y lisait QUE le
// jeton : un `web.env` portant `VALXOS_WEB_PORT=9911` voyait la porte annoncer
// 8790, sans un mot (sonde du 22/08). L'ENV garde le dernier mot : c'est ce qui
// permet d'ouvrir une deuxième porte sans toucher au fichier.
//
// La LECTURE n'écrit rien : c'est ce qui permet de garder l'ordre ci-dessus —
// l'hôte se vérifie avant que quoi que ce soit ne touche le disque, jeton
// compris.
let hote;
let port;
let cadreAutorise;
let operateur;
try {
  ({ hote, port, operateur, cadreAutorise } = reglagesDeLaPorte());
  verifierLHote(hote);
} catch (erreur) {
  process.stderr.write(`${erreur.message}\n`);
  process.exit(2);
}

const jeton = chargerLeJeton();
const db = getDatabase();
const porte = await ouvrirLaPorte({ db, jeton, hote, port, operateur, cadreAutorise });

// Une seule ligne sur la sortie standard, lisible par une machine comme par un
// humain. Le jeton, lui, ne s'imprime JAMAIS : il vit dans un fichier en 0600,
// et un journal n'est pas un fichier en 0600.
process.stdout.write(`PORTE ${porte.adresse.address}:${porte.adresse.port}\n`);
process.stderr.write(
  "VALXOS Messenger web door open. First visit: " +
    `http://127.0.0.1:${porte.adresse.port}/?t=<token from ${fichierDuJeton()}>\n`
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    porte.fermer().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}
