// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
// LE CARNET DES TABLES — un carnet d'adresses, jamais une boîte.
//
// Une TABLE est un nom, une liste de MEMBRES (des adresses que le guichet
// accepte déjà : lignée, chaise `lignée#session`, adresse humaine `lignée@nom`,
// carte nue), un réglage de RÉVEIL, un MODE, un drapeau FERMÉE et une POSITION
// libre. Écrire à `table:<nom>` crée une lettre PAR MEMBRE (guichet.js,
// `posterAUneTable`) : aucun courrier n'est jamais « à la table » dans la base,
// et une table ne garde rien. C'est pour ça que ce fichier ne touche ni
// `messages` ni `delivery_events` : il ne sait que dire À QUI écrire et
// COMMENT réveiller.
//
// Camp B : une table ne se supprime pas (`creerTable` refuse un nom déjà pris,
// même sans membre), un membre retiré reste en ligne avec son heure de retrait
// (`retire_le`) et se réactive en remettant cette heure à NULL. L'enclos suit la
// même règle : retiré, il est MARQUÉ (`retire_le`, `retire_par`), jamais
// effacé, et re-poser le réactive. Ce fichier n'efface aucune ligne.
//
// Les refus portent un `code` (comme `clef_indisponible` au guichet) : le
// serveur MCP, la CLI et la porte web les rendent sans jamais relire le texte.
// Le texte, lui, est anglais : il finit devant un inconnu.
import { nowIso } from "./config.js";
import { SEPARATEUR_INSTANCE, SEPARATEUR_SESSION, estUneChaiseCourte, getInstance, listInstances } from "./registry.js";

export const REGLES_REVEIL = ["reveil", "prochain-tour"];
export const MODES = ["normal", "direct"];
export const LONGUEUR_POSITION = 120;

// `[a-z0-9][a-z0-9-]{0,31}` : un nom qu'on tape dans `to: "table:<nom>"` sans
// jamais le confondre avec une adresse (`#`, `@`) ni avec un drapeau (`-x`).
const NOM_DE_TABLE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Un refus finit devant un inconnu, par le MCP ou la CLI : il ne recopie de
// l'entrée que ECHO_MAX caractères (des points de code), les caractères de
// contrôle — retours à la ligne compris — remplacés par une espace.
const ECHO_MAX = 64;
function echo(valeur) {
  const points = [...String(valeur ?? "")];
  const court = points.slice(0, ECHO_MAX).join("").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  return points.length > ECHO_MAX ? `${court}…` : court;
}

// « no such table » : la seule panne qu'une lecture d'enclos ou de serrure peut
// prendre pour « aucun enclos » (un bureau d'avant la version 7). Toute autre
// erreur — base verrouillée, colonne absente, disque — remonte.
const TABLE_ABSENTE = /no such table/i;

function refus(code, message, proprietes = {}) {
  const erreur = new Error(message);
  erreur.code = code;
  Object.assign(erreur, proprietes);
  return erreur;
}

export function validerNomDeTable(nom) {
  const normalise = typeof nom === "string" ? nom.trim().toLowerCase() : "";
  if (!NOM_DE_TABLE.test(normalise)) {
    throw refus(
      "nom-de-table-invalide",
      `"${echo(typeof nom === "string" ? nom : String(nom))}" is not a table name: 1 to 32 characters among a-z, 0-9 and "-", starting with a letter or a digit`
    );
  }
  return normalise;
}

// Les trois validateurs du carnet sont PURS (aucune base) et exportés : la CLI
// (`valxos-table`) les appelle pour refuser avant d'ouvrir la base, sous le même
// code et la même phrase que le carnet — jamais une copie de la règle.
export function validerReveil(reveil) {
  const regle = String(reveil ?? "").trim();
  if (!REGLES_REVEIL.includes(regle)) {
    throw refus("reveil-invalide", `"${echo(regle)}" is not a wake rule: use "reveil" or "prochain-tour"`);
  }
  return regle;
}

export function validerMode(mode) {
  const voulu = String(mode ?? "").trim();
  if (!MODES.includes(voulu)) {
    throw refus("mode-invalide", `"${echo(voulu)}" is not a table mode: use "normal" or "direct"`);
  }
  return voulu;
}

// Une adresse de membre est une adresse que le guichet accepte : un mot sans
// blanc. Jamais `table:` — une table n'est pas membre d'une table.
export function validerAdresse(adresse) {
  const voulue = String(adresse ?? "").trim();
  if (!voulue || /\s/.test(voulue) || voulue.toLowerCase().startsWith("table:")) {
    throw refus(
      "adresse-invalide",
      `"${echo(voulue)}" is not a member address: a lineage, a chair (lineage#session), a human address (lineage@name) or a bare card, without spaces`
    );
  }
  return voulue;
}

// ── CRÉER, LIRE ──────────────────────────────────────────────────────────────

export function obtenirTable(db, nom) {
  const normalise = typeof nom === "string" ? nom.trim().toLowerCase() : "";
  if (!NOM_DE_TABLE.test(normalise)) return null;
  return db.prepare("SELECT * FROM tables WHERE nom = ?").get(normalise) || null;
}

// Un seul INSERT, et c'est la clef primaire qui tranche « existe déjà » : deux
// gestes humains au même instant (deux CLI) ne se départagent pas en
// JavaScript optimiste, ils se départagent dans SQLite.
//
// `fermee` est un BOOLÉEN : une chaîne `"false"` serait vraie en JavaScript et
// fermerait la table. Qui reçoit du texte (la CLI) le convertit avant d'appeler.
export function creerTable(db, { nom, fermee = false, reveil = "reveil", mode = "normal", creeePar = null, now = nowIso() } = {}) {
  const nomValide = validerNomDeTable(nom);
  const regle = validerReveil(reveil);
  const modeValide = validerMode(mode);
  try {
    db.prepare(`
      INSERT INTO tables (nom, fermee, reveil, mode, creee_par, creee_le, modifiee_le)
      VALUES (@nom, @fermee, @reveil, @mode, @creeePar, @now, @now)
    `).run({ nom: nomValide, fermee: fermee ? 1 : 0, reveil: regle, mode: modeValide, creeePar: creeePar || null, now });
  } catch (erreur) {
    if (/^SQLITE_CONSTRAINT_(PRIMARYKEY|UNIQUE)$/.test(String(erreur?.code || ""))) {
      throw refus(
        "table-existe",
        `table "${nomValide}" already exists: tables are never deleted — add members to it or pick another name`,
        { nom: nomValide }
      );
    }
    throw erreur;
  }
  return obtenirTable(db, nomValide);
}

// `adresses` : une chaîne ou un tableau ; vide → rien (ce n'est pas « toutes »).
function listeDAdresses(adresses) {
  const brut = Array.isArray(adresses) ? adresses : [adresses];
  return [...new Set(brut.map((a) => String(a ?? "").trim()).filter(Boolean))];
}

// Sans `adresses` : les tables OUVERTES — une table fermée n'est vue que de ses
// membres (SPEC_A §7). Avec `adresses` : les tables dont un membre ACTIF porte
// une de ces adresses, sous la forme écrite (la lignée seule n'est pas la
// chaise `lignée#session`), fermées comprises.
export function listerTables(db, { adresses = null } = {}) {
  if (adresses === null || adresses === undefined) {
    return db.prepare("SELECT * FROM tables WHERE fermee = 0 ORDER BY nom").all();
  }
  const liste = listeDAdresses(adresses);
  if (liste.length === 0) return [];
  const marques = liste.map(() => "?").join(", ");
  return db.prepare(`
    SELECT t.* FROM tables t
    WHERE EXISTS (
      SELECT 1 FROM table_membres m
      WHERE m.nom_table = t.nom AND m.retire_le IS NULL AND m.adresse IN (${marques})
    )
    ORDER BY t.nom
  `).all(...liste);
}

// ── LES MEMBRES ──────────────────────────────────────────────────────────────

function tableExigee(db, nom) {
  const table = obtenirTable(db, nom);
  if (!table) throw refus("table-inconnue", `no table named "${echo(nom)}"`, { nom: echo(nom) });
  return table;
}

// `modifiee_le` dit la dernière modification de la table OU de ses membres.
function toucher(db, nomTable, now) {
  db.prepare("UPDATE tables SET modifiee_le = ? WHERE nom = ?").run(now, nomTable);
}

function lireMembre(db, nomTable, adresse) {
  return db.prepare("SELECT * FROM table_membres WHERE nom_table = ? AND adresse = ?").get(nomTable, adresse) || null;
}

// Un membre ACTIF ré-ajouté garde la date et l'auteur de son entrée : le geste
// ne fait que régler son réveil (c'est ainsi que `table_manage reveil` règle
// un membre). Un membre RETIRÉ reprend place avec un cachet neuf, et son heure
// de retrait revient à NULL — Camp B : la ligne n'a jamais disparu.
//
// LE RÉVEIL D'UN MEMBRE EST LE SIEN (ruling de la Tâche 3, fait en Tâche 6) :
// `reveil` OMIS (`undefined`) ne touche pas le réglage déjà écrit — un membre
// actif ré-ajouté, ou un membre retiré qui revient, garde le sien ; un membre
// neuf suit la table (NULL). `reveil: null`, dit exprès, rend le membre au
// réglage de la table. C'est la convention de `modifierTable` (`undefined` = ne
// bouge pas, `null` efface). La règle vit ICI, une fois : le serveur MCP et la
// CLI appellent sans la recopier.
export function ajouterMembre(db, nom, adresse, { reveil, ajoutePar = null, now = nowIso() } = {}) {
  const table = tableExigee(db, nom);
  const membre = validerAdresse(adresse);
  const garderLeReveil = reveil === undefined ? 1 : 0;
  const regle = reveil === null || reveil === undefined ? null : validerReveil(reveil);
  db.prepare(`
    INSERT INTO table_membres (nom_table, adresse, reveil, ajoute_par, ajoute_le, retire_par, retire_le)
    VALUES (@nom, @adresse, @reveil, @ajoutePar, @now, NULL, NULL)
    ON CONFLICT(nom_table, adresse) DO UPDATE SET
      reveil = CASE WHEN @garderLeReveil = 1 THEN table_membres.reveil ELSE excluded.reveil END,
      ajoute_par = CASE WHEN table_membres.retire_le IS NULL THEN table_membres.ajoute_par ELSE excluded.ajoute_par END,
      ajoute_le = CASE WHEN table_membres.retire_le IS NULL THEN table_membres.ajoute_le ELSE excluded.ajoute_le END,
      retire_par = NULL,
      retire_le = NULL
  `).run({ nom: table.nom, adresse: membre, reveil: regle, garderLeReveil, ajoutePar: ajoutePar || null, now });
  toucher(db, table.nom, now);
  return lireMembre(db, table.nom, membre);
}

// Marquer, jamais effacer : la ligne reste avec son heure et l'auteur du geste.
//
// Un expéditeur ENCLOS dans cette table ne s'en retire pas : l'enclos tient dans
// une table fermée dont il est membre, et le laisser partir l'enfermerait dans
// une table qui ne le compte plus. Retirer l'enclos (`retirerEnclos`) lève la
// serrure, puis le retrait passe. La lecture de l'enclos et le marquage tiennent
// dans UNE transaction : un enclos posé entre les deux ne passerait pas.
export function retirerMembre(db, nom, adresse, { retirePar = null, now = nowIso() } = {}) {
  return db.transaction(() => {
    const table = tableExigee(db, nom);
    const membre = String(adresse ?? "").trim();
    if (!membre) return false;
    const enclos = enclosDe(db, membre);
    if (enclos && enclos.nom_table === table.nom) {
      throw refus(
        "table-sous-enclos",
        `"${echo(membre)}" is enclosed in table "${table.nom}": remove the enclosure before removing the member`,
        { nom: table.nom, expediteur: membre }
      );
    }
    const info = db.prepare(`
      UPDATE table_membres SET retire_par = @retirePar, retire_le = @now
      WHERE nom_table = @nom AND adresse = @adresse AND retire_le IS NULL
    `).run({ nom: table.nom, adresse: membre, retirePar: retirePar || null, now });
    if (info.changes > 0) toucher(db, table.nom, now);
    return info.changes > 0;
  }).immediate();
}

export function membresDeTable(db, nom) {
  const table = obtenirTable(db, nom);
  if (!table) return [];
  return db.prepare(`
    SELECT adresse, reveil, ajoute_par, ajoute_le FROM table_membres
    WHERE nom_table = ? AND retire_le IS NULL
    ORDER BY adresse
  `).all(table.nom);
}

// Sous la forme ÉCRITE : le guichet passe toutes les formes de l'expéditeur
// (`formesDeLExpediteur`), ce fichier n'en invente aucune.
export function estMembre(db, nom, adresses) {
  const table = obtenirTable(db, nom);
  if (!table) return false;
  const liste = listeDAdresses(adresses);
  if (liste.length === 0) return false;
  const marques = liste.map(() => "?").join(", ");
  const ligne = db.prepare(`
    SELECT 1 AS oui FROM table_membres
    WHERE nom_table = ? AND retire_le IS NULL AND adresse IN (${marques})
    LIMIT 1
  `).get(table.nom, ...liste);
  return Boolean(ligne);
}

// ── MODIFIER ─────────────────────────────────────────────────────────────────

// La position est du texte non fiable comme le reste (SPEC_A §7) : on la
// borne à LONGUEUR_POSITION caractères — des points de code, pas des unités
// UTF-16, pour ne pas couper un emoji en deux. Vide → NULL.
function positionBornee(position) {
  if (position === null || position === undefined) return null;
  const texte = [...String(position).trim()].slice(0, LONGUEUR_POSITION).join("");
  return texte || null;
}

// Les enclos ACTIFS d'une table (`retire_le` à NULL), triés par expéditeur :
// `{ expediteur, pose_par, pose_le }`. C'est la lecture par TABLE de ce que
// `enclosDe` lit par expéditeur — la règle « actif » écrite une fois, pour la
// serrure de `modifierTable` et pour la vue de l'opérateur (`valxos-table voir`).
// Un nom qui ne peut pas exister n'a aucun enclos ; un bureau sans la table
// `enclos` non plus (même doctrine que `enclosDe`).
export function enclosDeTable(db, nomTable) {
  const normalise = typeof nomTable === "string" ? nomTable.trim().toLowerCase() : "";
  if (!NOM_DE_TABLE.test(normalise)) return [];
  try {
    return db
      .prepare("SELECT expediteur, pose_par, pose_le FROM enclos WHERE nom_table = ? AND retire_le IS NULL ORDER BY expediteur")
      .all(normalise);
  } catch (erreur) {
    if (TABLE_ABSENTE.test(String(erreur?.message || ""))) return [];
    throw erreur;
  }
}

// Les expéditeurs que des enclos ACTIFS tiennent dans cette table.
function expediteursEnfermes(db, nomTable) {
  return enclosDeTable(db, nomTable).map((ligne) => ligne.expediteur);
}

// Chaque champ est optionnel (`undefined` = ne bouge pas). `position: null`
// efface, avec l'heure et l'auteur du geste. `modifiee_le` avance dès qu'un
// champ est donné ; sans champ, la ligne est rendue telle quelle.
//
// `fermee` est un BOOLÉEN (voir `creerTable`). Une table qui porte un enclos
// ACTIF ne se rouvre pas : `fermee: false` lève `table-sous-enclos` et rien ne
// change, pas même un autre champ donné avec lui. Retirer l'enclos lève la
// serrure. La lecture des enclos et l'écriture tiennent dans UNE transaction.
export function modifierTable(db, nom, { reveil, mode, fermee, position, positionPar = null, now = nowIso() } = {}) {
  return db.transaction(() => {
    const table = tableExigee(db, nom);
    const champs = [];
    const valeurs = { nom: table.nom, now };
    if (reveil !== undefined) {
      valeurs.reveil = validerReveil(reveil);
      champs.push("reveil = @reveil");
    }
    if (mode !== undefined) {
      valeurs.mode = validerMode(mode);
      champs.push("mode = @mode");
    }
    if (fermee !== undefined) {
      valeurs.fermee = fermee ? 1 : 0;
      champs.push("fermee = @fermee");
    }
    if (position !== undefined) {
      valeurs.position = positionBornee(position);
      valeurs.positionPar = positionPar || null;
      champs.push("position = @position", "position_par = @positionPar", "position_le = @now");
    }
    if (champs.length === 0) return table;
    if (valeurs.fermee === 0) {
      const enfermes = expediteursEnfermes(db, table.nom);
      if (enfermes.length > 0) {
        throw refus(
          "table-sous-enclos",
          `table "${table.nom}" holds an active enclosure (sender "${echo(enfermes[0])}"): remove the enclosure before opening the table`,
          { nom: table.nom, expediteur: enfermes[0] }
        );
      }
    }
    db.prepare(`UPDATE tables SET ${champs.join(", ")}, modifiee_le = @now WHERE nom = @nom`).run(valeurs);
    return obtenirTable(db, table.nom);
  }).immediate();
}

// ── LES FORMES DE L'EXPÉDITEUR (au carnet depuis S9, venues du guichet) ──────
// Une table liste ses membres sous la forme que l'humain a tapée : une lignée
// (`alice`), une chaise (`alice#s-1`), une adresse humaine (`alice@atelier`).
// L'expéditeur, lui, poste sous UNE forme — celle que le serveur dérive. Pour
// ne jamais lui écrire sa propre lettre (point de revue 3) et pour lire son
// enclos quelle que soit la forme sous laquelle on l'a posé, on énumère ce
// qu'il EST : son nom, sa lignée (avant `#`), sa chaise, et son adresse humaine
// quand sa chaise porte un `session_name`. Lecture seule de la fiche, jamais
// une résolution : on ne demande pas au guichet « à qui mène alice ».
// Sans `chaiseId`, un `sender` qui est déjà une chaise (`lignée#session`)
// tient lieu de chaise : c'est le cas du serveur MCP, qui poste sous sa chaise.
// A5 (relecture du guichet) : un `sender` qui est une ADRESSE HUMAINE
// (`lignée@nom`, la CLI ou la porte, `sender_chaise` nul) donne aussi sa
// lignée — l'enclos posé sur elle se lit, et une table qui la liste ne lui
// écrit pas sa propre lettre.
export function formesDeLExpediteur(db, sender, { chaiseId = null } = {}) {
  const formes = new Set();
  const nom = String(sender || "").trim();
  if (nom) {
    formes.add(nom);
    formes.add(nom.split(SEPARATEUR_INSTANCE)[0]);
    formes.add(nom.split(SEPARATEUR_SESSION)[0]);
  }
  const chaise = String(chaiseId || "").trim() || (nom.includes(SEPARATEUR_INSTANCE) ? nom : "");
  if (chaise) {
    formes.add(chaise);
    formes.add(chaise.split(SEPARATEUR_INSTANCE)[0]);
    let fiche = null;
    try {
      fiche = getInstance(db, chaise);
    } catch {
      fiche = null; // une fiche illisible ne retient pas la lettre
    }
    if (fiche?.lineage && fiche?.session_name) {
      formes.add(`${fiche.lineage}${SEPARATEUR_SESSION}${fiche.session_name}`);
    }
  }
  return [...formes].filter(Boolean);
}

// La chaise qu'un expéditeur EST (`lignée#session`), ou null : `chaiseId`
// quand la surface la donne, sinon un `sender` qui en est une (le serveur MCP
// poste sous sa chaise). Même lecture que `formesDeLExpediteur`.
function chaiseDeLExpediteur(sender, chaiseId) {
  const nom = String(sender || "").trim();
  return String(chaiseId || "").trim() || (nom.includes(SEPARATEUR_INSTANCE) ? nom : null);
}

// Un enclos posé sur `adresse` tient-il l'expéditeur dont voici les formes et
// la chaise ? Oui quand l'adresse est l'une de ses formes, ou la CHAISE COURTE
// de sa chaise (`lignée#<8 hex ou plus>`, la session lue sans casse, comme la
// résolution la lit) : l'enclos posé sur la forme courte `alice#<8 hex>` tient
// la chaise entière `alice#<8 hex>-…` qui poste.
function enclosTient(adresse, formes, chaise) {
  if (formes.includes(adresse)) return true;
  if (!chaise || !estUneChaiseCourte(adresse)) return false;
  const coupe = adresse.indexOf(SEPARATEUR_INSTANCE);
  const coupeChaise = chaise.indexOf(SEPARATEUR_INSTANCE);
  return coupeChaise > 0
    && chaise.slice(0, coupeChaise) === adresse.slice(0, coupe).trim()
    && chaise.slice(coupeChaise + 1).toLowerCase().startsWith(adresse.slice(coupe + 1).trim().toLowerCase());
}

// Les enclos ACTIFS du bureau, par expéditeur. Un bureau d'avant la version 7
// n'en a aucun (même doctrine que `enclosDe`).
function enclosActifs(db) {
  try {
    return db
      .prepare("SELECT expediteur, nom_table, pose_par, pose_le FROM enclos WHERE retire_le IS NULL ORDER BY expediteur")
      .all();
  } catch (erreur) {
    if (TABLE_ABSENTE.test(String(erreur?.message || ""))) return [];
    throw erreur;
  }
}

// N3 (re-revue du round 2) : les enclos ACTIFS des AUTRES formes de la même lignée que `adresse`
// (la lignée elle-même, ses chaises, ses chaises courtes, ses adresses humaines) — ce qui peut encore
// tenir l'expéditeur quand on vient de lever l'enclos d'une seule de ses formes.
export function enclosDesAutresFormes(db, adresse) {
  const qui = String(adresse ?? "").trim();
  const lignee = (nom) => nom.split(SEPARATEUR_INSTANCE)[0].split(SEPARATEUR_SESSION)[0];
  return enclosActifs(db).filter((enclos) => enclos.expediteur !== qui && lignee(enclos.expediteur) === lignee(qui));
}

// S9 (seconde passe adverse) : TOUS les enclos actifs qui tiennent cet
// expéditeur, sous chacune de ses formes — jamais le premier trouvé. Le guichet
// en refuse la lettre quand ils visent deux tables (`verifierEnclos`).
export function enclosQuiTiennent(db, sender, { chaiseId = null } = {}) {
  const formes = formesDeLExpediteur(db, sender, { chaiseId });
  const chaise = chaiseDeLExpediteur(sender, chaiseId);
  return enclosActifs(db).filter((enclos) => enclosTient(enclos.expediteur, formes, chaise));
}

// Un enclos posé sur `qui` vers `nomTable` et un enclos actif vers une AUTRE
// table tiendraient-ils un même expéditeur ? On essaie chaque expéditeur que
// le bureau sait nommer pour ces deux adresses : `qui` lui-même, chaque adresse
// déjà enclose, et chaque chaise de la fiche de sa lignée (une adresse humaine
// mène à une chaise par son nom de session). Rend l'enclos qui gêne, ou null.
function enclosQuiGene(db, qui, nomTable) {
  const ailleurs = enclosActifs(db).filter((enclos) => enclos.expediteur !== qui && enclos.nom_table !== nomTable);
  if (ailleurs.length === 0) return null;
  const lignee = qui.split(SEPARATEUR_INSTANCE)[0].split(SEPARATEUR_SESSION)[0];
  let chaises = [];
  try {
    chaises = listInstances(db, lignee, { includeOffline: true }).map((fiche) => fiche.id);
  } catch {
    chaises = []; // une fiche illisible ne retient pas le geste : les autres candidats restent
  }
  for (const candidat of new Set([qui, ...ailleurs.map((enclos) => enclos.expediteur), ...chaises])) {
    const formes = formesDeLExpediteur(db, candidat);
    const chaise = chaiseDeLExpediteur(candidat, null);
    if (!enclosTient(qui, formes, chaise)) continue;
    const gene = ailleurs.find((enclos) => enclosTient(enclos.expediteur, formes, chaise));
    if (gene) return gene;
  }
  return null;
}

// ── L'ENCLOS ─────────────────────────────────────────────────────────────────
//
// Si `enclos` a une ligne ACTIVE pour un expéditeur (`retire_le` à NULL),
// chacune de ses lettres ne part que vers les membres de la table FERMÉE
// nommée (guichet.js, `verifierEnclos`), sauf `hors_enclos: true`. L'enclos ne
// se pose et ne se retire que par la CLI (`valxos-table enclos`), à la demande
// de l'expéditeur : c'est la serrure qu'il demande, et la clef reste dans sa
// main. Camp B : retirer l'enclos le MARQUE, re-poser le réactive.
//
// Trois invariants tiennent l'enclos debout : la table est FERMÉE
// (`enclos-table-ouverte`), l'expéditeur en est membre ACTIF (`pas-membre`,
// sous la forme écrite), et tant que l'enclos vit ni la table ne se rouvre ni
// l'expéditeur ne s'en retire (`table-sous-enclos`, voir `modifierTable` et
// `retirerMembre`).

// Les refus et l'écriture tiennent dans UNE transaction (comme `poserAlias`) :
// un `retirerMembre` lancé par une autre CLI ne passe pas entre les deux.
export function poserEnclos(db, expediteur, nomTable, { posePar = null, now = nowIso() } = {}) {
  return db.transaction(() => {
    const table = tableExigee(db, nomTable);
    if (Number(table.fermee) !== 1) {
      throw refus(
        "enclos-table-ouverte",
        `table "${table.nom}" is open: an enclosure only holds a sender inside a closed table (close it first)`,
        { nom: table.nom }
      );
    }
    const qui = validerAdresse(expediteur);
    if (!estMembre(db, table.nom, qui)) {
      throw refus(
        "pas-membre",
        `"${echo(qui)}" is not an active member of table "${table.nom}": add it to the table before enclosing it`,
        { nom: table.nom, expediteur: qui }
      );
    }
    // B8 (relecture du carnet) : un enclos ACTIF ne se déplace pas en silence
    // vers une autre table — la table quittée pourrait ensuite se rouvrir sans
    // que personne l'ait voulu. On le lève d'abord (`retirerEnclos`) ; re-poser
    // sur la même table reste un geste sans surprise.
    const actif = enclosDe(db, qui);
    if (actif && actif.nom_table !== table.nom) {
      throw refus(
        "enclos-existe",
        `"${echo(qui)}" is already enclosed in table "${actif.nom_table}": lift it first (valxos-table enclos --retirer)`,
        { nom: actif.nom_table, expediteur: qui }
      );
    }
    // S9 (seconde passe adverse) : ni sous UNE AUTRE de ses formes. `alice`
    // enclos dans « one » et `alice#s1` dans « two » tiendraient la même chaise
    // dans deux tables. Le guichet refuse un tel conflit hérité ; le carnet ne
    // le laisse plus naître.
    const gene = enclosQuiGene(db, qui, table.nom);
    if (gene) {
      throw refus(
        "enclos-existe",
        `"${echo(qui)}" is the same sender as "${echo(gene.expediteur)}", already enclosed in table "${gene.nom_table}": ` +
          `lift that enclosure first (valxos-table enclos --retirer ${echo(gene.expediteur)})`,
        { nom: gene.nom_table, expediteur: gene.expediteur }
      );
    }
    db.prepare(`
      INSERT INTO enclos (expediteur, nom_table, pose_par, pose_le)
      VALUES (@expediteur, @nomTable, @posePar, @now)
      ON CONFLICT(expediteur) DO UPDATE SET
        nom_table = excluded.nom_table,
        pose_par = excluded.pose_par,
        pose_le = excluded.pose_le,
        retire_par = NULL,
        retire_le = NULL
    `).run({ expediteur: qui, nomTable: table.nom, posePar: posePar || null, now });
    return enclosDe(db, qui);
  }).immediate();
}

// Marquer, jamais effacer : la ligne reste avec son heure et l'auteur du geste,
// comme `retirerMembre`. Rend `true` s'il y avait un enclos actif.
export function retirerEnclos(db, expediteur, { retirePar = null, now = nowIso() } = {}) {
  const qui = String(expediteur ?? "").trim();
  if (!qui) return false;
  return db.prepare(`
    UPDATE enclos SET retire_par = @retirePar, retire_le = @now
    WHERE expediteur = @qui AND retire_le IS NULL
  `).run({ qui, retirePar: retirePar || null, now }).changes > 0;
}

// Lu à CHAQUE envoi par le guichet : l'enclos ACTIF de l'expéditeur, ou `null`.
// Un bureau où la table n'a pas pu naître (« no such table ») n'a simplement
// aucun enclos — jamais une porte fermée (doctrine de `lireAlias`,
// registry.js). C'est la seule panne avalée : une serrure que l'expéditeur a
// demandée ne s'ouvre pas en silence sur une base verrouillée ou une colonne
// absente, ces erreurs-là remontent.
export function enclosDe(db, expediteur) {
  const qui = String(expediteur ?? "").trim();
  if (!qui) return null;
  try {
    return db
      .prepare("SELECT expediteur, nom_table, pose_par, pose_le FROM enclos WHERE expediteur = ? AND retire_le IS NULL")
      .get(qui) || null;
  } catch (erreur) {
    if (TABLE_ABSENTE.test(String(erreur?.message || ""))) return null;
    throw erreur;
  }
}
