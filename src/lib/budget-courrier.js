// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
//
// LE BUDGET DU COURRIER DES CROCHETS (1.1.0, Tâche 7, 21/11) — un seul endroit, pour SessionStart
// et PostToolUse.
//
// Claude Code range dans un fichier tout ce qu'un crochet rend au-delà d'environ 10 000
// caractères, et le modèle n'en reçoit qu'un aperçu d'environ 2 000 (mesuré sur un vrai Claude
// Code 2.1.330 : 9 892 caractères vus entiers, 11 892 déversés). Les deux crochets n'avaient aucun
// budget et tamponnaient `*_delivered` avant la mise en forme : au-dessus du seuil, des lettres
// étaient marquées livrées sans avoir été vues. Les lois, maintenant :
//   1. Tout `additionalContext` (lettres, annonces, copies cc et ligne d'attente) tient dans
//      BUDGET_CONTEXTE_CROCHET caractères (la `.length` de JS), quelles que soient les lettres.
//   2. Une lettre n'est marquée livrée que si son corps ENTIER est dans la sortie ; une copie n'est
//      marquée vue (`cc_vu`) que si elle est montrée entière.
//   3. Ce qui ne tient pas attend, sans marque : le battement suivant le reprend. La sortie finit
//      alors par une ligne qui dit combien de lettres attendent, et que `inbox` les lit.
//   4. Une lettre qui ne tiendrait jamais seule est ANNONCÉE : son en-tête, sa taille, son début
//      (LONGUEUR_EXTRAIT_ANNONCE), et la phrase qui renvoie à `inbox`. L'événement est `announced`
//      (le mot du plugin Hermes), jamais `delivered_at`. Trois annonces au plus, comptées au journal ;
//      ensuite elle se tait, mais elle reste comptée dans la ligne d'attente quand une ligne se dit.
//   5. Sous le budget, rien ne change : la sortie est celle d'avant, à l'octet.
//   8. L'ordre est celui d'avant (`seq`) ; une lettre qui ne tient pas ne retient pas les plus
//      petites qui la suivent.
//
// LA MARQUE AVANT LA FORME, gardée pour ce qui se montre (1.1.0, Tâche 8) : `markDelivered` compte
// le re-service et `enrichirPourAffichage` lit ce compte en base pour nommer le rappel
// (`Reminder: n`). On CHOISIT d'abord, sur une mesure qui prévoit le rappel à venir
// (`avecLeRappelAVenir`, la règle de `markDelivered`) ; puis, dans UNE transaction, on marque ce
// qui a été choisi, on relit l'en-tête en base, on met en forme et on mesure la chaîne finale. Elle
// ne peut dépasser que si un autre processus a changé un en-tête entre la lecture et la marque (un
// rappel, un nom de chaise) : la transaction s'annule et le choix se refait une fois, plus petit
// du dépassement ; une seconde forme qui ne tient pas ne marque rien et ne rend rien — tout attend.
// La même doctrine que les crochets Codex (`deliverLetters`, hooks/codex/harness-common.js).
import {
  enrichirPourAffichage,
  getCopiesPourChaise,
  getPendingForContext,
  markDelivered,
  marquerCopiesVues,
  recordEvent
} from "./database.js";
import { formatAdditionalContext, formatCopies } from "./format.js";

export const BUDGET_CONTEXTE_CROCHET = 9000;
export const LONGUEUR_EXTRAIT_ANNONCE = 1500;
export const ANNONCES_AU_PLUS = 3;
export const EVENEMENT_ANNONCE = "announced";

const DEPASSEMENT = Symbol("depassement");
const ESSAIS = 2;

// La dernière ligne quand quelque chose attend. Ses formes s'allongent avec ses comptes : une
// ligne mesurée sur des comptes plus grands que ceux qu'elle dira n'est jamais plus courte.
export function ligneDAttente({ lettres = 0, copies = 0 } = {}) {
  const parts = [];
  if (lettres > 0) parts.push(`${lettres} letter(s)`);
  if (copies > 0) parts.push(`${copies} cc copy(ies)`);
  if (parts.length === 0) return "";
  const etat = lettres > 0 ? "not shown in full here, not marked delivered" : "not shown in full here";
  return `VALXOS Messenger: ${parts.join(" and ")} wait for this session (${etat}); the \`inbox\` tool reads them now.`;
}

// Le début d'une lettre annoncée : au plus `longueur` unités, coupé entre deux graphèmes (un
// emoji, une famille ZWJ, une lettre accentuée ne se coupent pas). Un graphème plus long que la
// borne (une base suivie de milliers de diacritiques) se coupe au point de code.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function extraitDe(texte, longueur = LONGUEUR_EXTRAIT_ANNONCE) {
  const corps = String(texte ?? "");
  if (corps.length <= longueur) return corps;
  let fin = 0;
  for (const { index, segment } of GRAPHEMES.segment(corps)) {
    if (index + segment.length > longueur) break;
    fin = index + segment.length;
  }
  if (fin === 0) {
    fin = longueur;
    const code = corps.charCodeAt(fin - 1);
    if (code >= 0xd800 && code <= 0xdbff) fin -= 1;
  }
  return corps.slice(0, fin);
}

export function enAnnonce(row) {
  const corps = String(row.body ?? "");
  return { ...row, annonce: { taille: corps.length, extrait: extraitDe(corps) } };
}

// Le rappel que CE service nommera : `markDelivered` compte un re-service quand la lettre était
// déjà livrée (`reservices + (delivered_at IS NOT NULL)`). Pour la mesure seulement.
function avecLeRappelAVenir(row) {
  if (!row.delivered_at) return row;
  const affichage = row.affichage || {};
  return { ...row, affichage: { ...affichage, rappel: (Number(affichage.rappel) || 0) + 1 } };
}

// La sortie, telle que les crochets l'écrivaient (lettres, puis copies), plus la ligne d'attente.
// Sans annonce ni attente, c'est la chaîne d'avant à l'octet.
export function composerLeCourrier({ lettres = [], copies = [], cc = {}, attente = null } = {}) {
  return [
    formatAdditionalContext(lettres),
    copies.length > 0 ? formatCopies(copies, cc.destinataire ?? null, cc) : "",
    attente ? ligneDAttente(attente) : ""
  ].filter(Boolean).join("\n\n");
}

// LE CHOIX, pur (aucune base). `lettres` : les lettres en attente dans l'ordre, telles qu'elles se
// montreraient servies ; `copies` : les copies cc, dans l'ordre ; `cc` : leur lignée
// (`destinataire`, `chaiseDesignee`, `sansChaiseDesignee`) ; `annoncesFaites(row)` : le compte des
// `announced` déjà posés ; `annoncer(row)` : la forme annoncée ; `auDela()` : ce qui attend
// au-delà de la borne SQL (paresseux : une requête de plus, seulement quand la ligne se dit).
// Rend `vide: true` quand rien n'est à dire, sinon `lettres` (la sortie, dans l'ordre, entières et
// annoncées), `livrees`, `annoncees`, `copies` (montrées) et `attente` (null : aucune ligne).
export function choisirSousLeBudget({
  lettres = [],
  copies = [],
  cc = {},
  annoncesFaites = () => 0,
  annoncer = enAnnonce,
  auDela = () => ({ lettres: 0, copies: 0 }),
  budget = BUDGET_CONTEXTE_CROCHET
} = {}) {
  const mesurer = (L, C, attente) => composerLeCourrier({ lettres: L, copies: C, cc, attente }).length;
  // SOUS LE BUDGET, RIEN NE CHANGE : quand tout tient entier, tout part, comme avant, sans ligne.
  if (lettres.length + copies.length === 0) return { vide: true };
  if (mesurer(lettres, copies, null) <= budget) {
    return { lettres, livrees: lettres, annoncees: [], copies, attente: null };
  }
  let auDelaLu = null;
  const auDelaConnu = () => (auDelaLu ??= auDela());
  let borneLue = null;
  // La ligne d'attente la plus longue possible : tout ce qui est en main, plus ce qui est au-delà.
  const borne = () => (borneLue ??= {
    lettres: lettres.length + auDelaConnu().lettres,
    copies: copies.length + auDelaConnu().copies
  });

  // Seule, elle tient (avec la plus longue ligne d'attente) : entière. Sinon annoncée, tant que
  // son annonce tient et qu'elle n'a pas déjà été annoncée trois fois. Sinon elle se tait.
  const annonces = new Map();
  const classes = lettres.map((row, i) => {
    if (mesurer([row], [], borne()) <= budget) return "entiere";
    annonces.set(i, annoncer(row));
    if (Number(annoncesFaites(row)) < ANNONCES_AU_PLUS && mesurer([annonces.get(i)], [], borne()) <= budget) return "annonce";
    return "silence";
  });
  const copiesVives = copies.filter((copie) => mesurer([], [copie], borne()) <= budget);
  const silence = {
    lettres: classes.filter((c) => c === "silence").length,
    copies: copies.length - copiesVives.length
  };
  const vives = lettres.filter((_, i) => classes[i] !== "silence");
  if (vives.length === 0 && copiesVives.length === 0) return { vide: true };

  // Seules des lettres qui se taisent empêchent tout de tenir : ce qui vit se montre entier, et la
  // ligne compte celles qui se taisent (une annonce épuisée, une copie trop longue).
  if (classes.every((c) => c !== "annonce")) {
    const attente = silence.lettres + silence.copies > 0
      ? { lettres: silence.lettres + auDelaConnu().lettres, copies: silence.copies + auDelaConnu().copies }
      : null;
    if (mesurer(vives, copiesVives, attente) <= budget) {
      return { lettres: vives, livrees: vives, annoncees: [], copies: copiesVives, attente };
    }
  }

  // AU-DESSUS : les entières d'abord, dans l'ordre (une qui ne tient pas ne retient pas les
  // suivantes) ; puis les annonces, dans la place qui reste ; puis les copies.
  const prises = new Set();
  const annoncees = new Set();
  const sortie = () => lettres
    .map((row, i) => (prises.has(i) ? row : annoncees.has(i) ? annonces.get(i) : null))
    .filter(Boolean);
  for (let i = 0; i < lettres.length; i += 1) {
    if (classes[i] !== "entiere") continue;
    prises.add(i);
    if (mesurer(sortie(), [], borne()) > budget) prises.delete(i);
  }
  for (let i = 0; i < lettres.length; i += 1) {
    if (classes[i] !== "annonce") continue;
    annoncees.add(i);
    if (mesurer(sortie(), [], borne()) > budget) annoncees.delete(i);
  }
  const lettresMontrees = sortie();
  const copiesMontrees = [];
  for (const copie of copiesVives) {
    copiesMontrees.push(copie);
    if (mesurer(lettresMontrees, copiesMontrees, borne()) > budget) copiesMontrees.pop();
  }
  return {
    lettres: lettresMontrees,
    livrees: lettres.filter((_, i) => prises.has(i)),
    annoncees: lettresMontrees.filter((row) => row.annonce),
    copies: copiesMontrees,
    attente: {
      lettres: lettres.length - prises.size + auDelaConnu().lettres,
      copies: copies.length - copiesMontrees.length + auDelaConnu().copies
    }
  };
}

// LE SERVICE D'UN CROCHET : choisir, puis marquer ce qui se montre et mettre en forme, d'un seul
// tenant. `lettres` et `cc` sont ce que le crochet a relevé (`getPendingForContext`,
// `copiesPourMoi`) avec sa borne `limit` ; `etiquette` est son `*_delivered`, `via` le nom du
// crochet au journal des annonces. Rend `{ texte, livrees, annoncees, copies, attente }` ; `texte`
// vide : rien à écrire, rien n'a été marqué.
export function servirSousLeBudget(db, {
  lettres,
  cc,
  adresses,
  selfId,
  etiquette,
  via,
  limit,
  budget = BUDGET_CONTEXTE_CROCHET
}) {
  const rien = { texte: "", lettres: [], livrees: [], annoncees: [], copies: [], attente: null };
  const brutes = enrichirPourAffichage(db, lettres, { lecteur: adresses });
  const parSeq = new Map(brutes.map((row) => [row.seq, row]));
  const copies = enrichirPourAffichage(db, cc.rows, { lecteur: adresses });
  const compterLesAnnonces = db.prepare("SELECT COUNT(*) AS n FROM delivery_events WHERE msg_id = ? AND event_type = ?");
  const auDela = () => ({
    lettres: lettres.length >= limit
      ? Math.max(0, getPendingForContext(db, adresses, { limit: -1 }).length - lettres.length)
      : 0,
    copies: cc.rows.length >= limit && cc.chaiseId
      ? Math.max(0, getCopiesPourChaise(db, cc.rows[0].recipient, cc.chaiseId, { limit: -1 }).length - cc.rows.length)
      : 0
  });

  let marge = 0;
  for (let essai = 0; essai < ESSAIS; essai += 1) {
    const choix = choisirSousLeBudget({
      lettres: brutes.map(avecLeRappelAVenir),
      copies,
      cc,
      // Une annonce montre l'en-tête d'aujourd'hui : aucun service, donc aucun rappel à venir.
      annoncer: (row) => enAnnonce(parSeq.get(row.seq) ?? row),
      annoncesFaites: (row) => compterLesAnnonces.get(row.msg_id, EVENEMENT_ANNONCE).n,
      auDela,
      budget: budget - marge
    });
    if (choix.vide) return rien;
    let texte = "";
    let exces = 0;
    try {
      db.transaction(() => {
        markDelivered(db, choix.livrees, selfId, etiquette);
        for (const row of choix.annoncees) {
          recordEvent(db, row.msg_id, selfId, EVENEMENT_ANNONCE, { taille: row.annonce.taille, via });
        }
        if (choix.copies.length > 0) marquerCopiesVues(db, choix.copies, cc.chaiseId);
        const relues = new Map(enrichirPourAffichage(db, choix.livrees, { lecteur: adresses }).map((row) => [row.seq, row]));
        texte = composerLeCourrier({
          lettres: choix.lettres.map((row) => (row.annonce ? row : relues.get(row.seq) ?? row)),
          copies: choix.copies,
          cc,
          attente: choix.attente
        });
        if (texte.length > budget) {
          exces = texte.length - budget;
          throw DEPASSEMENT;
        }
      })();
    } catch (erreur) {
      if (erreur !== DEPASSEMENT) throw erreur;
      marge += exces;
      continue;
    }
    return { texte, lettres: choix.lettres, livrees: choix.livrees, annoncees: choix.annoncees, copies: choix.copies, attente: choix.attente };
  }
  return rien;
}

// ── LA RELÈVE DE `inbox` SOUS BUDGET (1.1.0, Tâche 7, tour des réserves) ────────────────────────
// Mesuré le 21/11 sur un vrai Claude Code 2.1.330 : un résultat d'`inbox` de 17 119 caractères
// arrive entier au modèle ; ceux de 68 344 et de 180 272 caractères sont rangés dans un fichier, et
// le modèle n'en lit RIEN (pas même un aperçu) — pendant que l'outil tamponnait les 28 lettres
// `mcp_inbox_delivered`. Le seuil de Claude Code se compte en jetons, et un jeton couvre au moins
// un octet : le budget se compte en octets UTF-8 du résultat entier (jamais moins que ses
// caractères), sous la mesure qui passe.
export const BUDGET_RESULTAT_INBOX = 16000;

export function tailleDuContenu(contenu) {
  return contenu.reduce((n, bloc) => n + Buffer.byteLength(String(bloc?.text ?? ""), "utf8"), 0);
}

// La ligne qui clôt une relève qui n'a pas tout montré (un bloc de texte après le JSON).
export function ligneDeSuiteDeLaReleve({ lettres = 0, copies = 0, apres = null, partie = null } = {}) {
  const phrases = [];
  if (partie && partie.fin < partie.taille) {
    phrases.push(`This letter continues: ${partie.fin} of ${partie.taille} characters shown; call \`inbox\` with its \`msg_id\` and \`offset: ${partie.fin}\` for the next part.`);
  }
  const reste = [];
  if (lettres > 0) reste.push(`${lettres} more letter(s)`);
  if (copies > 0) reste.push(`${copies} more cc copy(ies)`);
  if (reste.length > 0) {
    const ou = apres === null || apres === undefined ? "" : ` with \`after: ${apres}\``;
    phrases.push(`${reste.join(" and ")} ${lettres + copies > 1 ? "are" : "is"} waiting; call \`inbox\` again${ou}.`);
  }
  return phrases.join(" ");
}

// LE CHOIX DE LA RELÈVE. `composer({ lettres, copies, suite })` rend le contenu MCP ; `suite` (null :
// tout est montré) porte `{ lettres, copies, apres }`, ce qui attend et le curseur. Tout tient : tout
// part, comme avant. Sinon le plus long DÉBUT de la boîte qui tient (dans l'ordre : une relève suivante
// reprend `after` le dernier `seq` montré — aucune lettre sautée en silence), puis les copies quand
// toutes les lettres sont montrées. Rien ne tient, pas même la première seule : `longue` la désigne,
// elle se lit par parties (`partieSousLeBudget`), et `suite` compte ce qui attend derrière elle.
export function choisirPourLaReleve({ lettres = [], copies = [], composer, budget = BUDGET_RESULTAT_INBOX }) {
  const taille = (L, C, suite) => tailleDuContenu(composer({ lettres: L, copies: C, suite }));
  if (taille(lettres, copies, null) <= budget) return { lettres, copies, suite: null, longue: null };
  const suiteDe = (L, C) => ({
    lettres: lettres.length - L.length,
    copies: copies.length - C.length,
    apres: L.length > 0 ? L.at(-1).seq : null
  });
  const prises = [];
  for (const row of lettres) {
    const essai = [...prises, row];
    if (taille(essai, [], suiteDe(essai, [])) > budget) break;
    prises.push(row);
  }
  const copiesPrises = [];
  if (prises.length === lettres.length) {
    for (const copie of copies) {
      const essai = [...copiesPrises, copie];
      if (taille(prises, essai, suiteDe(prises, essai)) > budget) break;
      copiesPrises.push(copie);
    }
  }
  // Rien ne tient, pas même la première seule : elle se lit par parties, et la suite dit ce qui
  // attend DERRIÈRE elle — `after` = son `seq` (revue de la tâche 7 : une lettre à l'en-tête démesuré
  // en tête de boîte ne doit pas cacher les suivantes à un `inbox` sans argument).
  if (prises.length === 0 && copiesPrises.length === 0) {
    return lettres.length > 0
      ? {
        lettres: [],
        copies: [],
        suite: { lettres: lettres.length - 1, copies: copies.length, apres: lettres[0].seq },
        longue: { row: lettres[0], copie: false }
      }
      : {
        lettres: [],
        copies: [],
        suite: { lettres: 0, copies: copies.length - 1, apres: null },
        longue: { row: copies[0], copie: true }
      };
  }
  return { lettres: prises, copies: copiesPrises, suite: suiteDe(prises, copiesPrises), longue: null };
}

// UNE PARTIE D'UNE LONGUE LETTRE : [debut, fin) en unités JS, jamais au milieu d'un point de code, la
// plus longue qui garde le résultat sous le budget. `composerLaPartie(debut, fin)` rend le contenu
// MCP. null : même une partie d'un caractère ne tient pas (un en-tête démesuré).
export function partieSousLeBudget({ corps, debut = 0, composerLaPartie, budget = BUDGET_RESULTAT_INBOX }) {
  const texte = String(corps ?? "");
  const n = texte.length;
  const basse = (i) => i > 0 && i < n && texte.charCodeAt(i) >= 0xdc00 && texte.charCodeAt(i) <= 0xdfff;
  let d = Math.max(0, Math.min(Number(debut) || 0, n));
  if (basse(d)) d -= 1;
  const aligne = (f) => (basse(f) ? f - 1 : f);
  const tient = (f) => tailleDuContenu(composerLaPartie(d, f)) <= budget;
  if (tient(n)) return { debut: d, fin: n, taille: n };
  let bas = d;
  let haut = n;
  while (haut - bas > 1) {
    const milieu = aligne(Math.floor((bas + haut) / 2));
    if (milieu <= bas) break;
    if (tient(milieu)) bas = milieu;
    else haut = milieu;
  }
  if (bas === d || !tient(bas)) return null;
  return { debut: d, fin: bas, taille: n };
}
