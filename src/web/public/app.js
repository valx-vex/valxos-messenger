// SPDX-FileCopyrightText: 2026 VALXOS contributors
// SPDX-License-Identifier: AGPL-3.0-only
// Licence complète : voir LICENSE à la racine du dépôt.
/* ═══ LA PORTE WEB — le front ══════════════════════════════════════════════
   Cette page NE DÉCIDE RIEN. Elle dessine ce que l'API rend, et c'est toute
   sa discipline : l'état d'une lettre se dérive de la base par
   `etatDeLaLettre` (src/lib/format.js) et arrive ici comme un MOT. La page ne
   regarde jamais un horodatage pour deviner où en est un pli — deux
   définitions de l'état, l'une au serveur l'autre à l'écran, divergeraient un
   jour sans bruit, et c'est justement le cachet qui mentirait.

   Trois choses seulement lui appartiennent : le msg_id qu'elle génère (la
   clef d'idempotence, faite pour être REJOUÉE), le destinataire choisi, et le
   texte tapé. Tout le reste vient du bureau.

   ── POURQUOI CE FICHIER EST UN MODULE ────────────────────────────────────
   Il est chargé en `<script type="module">`, et ce n'est pas une coquetterie :
   sans `export`, les fonctions qui traduisent les réponses de l'API
   (`normaliserLettre`, `normaliserBoite`, `attendUnAccuse`…) n'étaient
   vérifiables par AUCUN test, et cinq d'entre elles lisaient des clefs que
   l'API n'écrit pas — la page affichait des boîtes mortes en vert et refusait
   d'offrir un accusé que le serveur exigeait. Un module s'importe depuis Node
   sans navigateur : `test/web-front.test.js` fait passer de VRAIES réponses de
   `/api/pairs` et `/api/fil` dans ces fonctions-là. C'est le seul verrou qui
   ferme la classe « les deux moitiés divergent » — recopier les formes à la
   main dans le test en aurait été une TROISIÈME définition, qui mentirait
   exactement comme le front mentait.

   Conséquence : rien ici ne touche au DOM à l'import. Les prises de la page
   sont nulles hors navigateur, et le branchement n'a lieu qu'au bas du fichier
   quand un `document` existe.
   ═══════════════════════════════════════════════════════════════════════ */

// Le navigateur, ou rien. En Node (les tests), `doc` est nul : le fichier
// s'importe alors pour ce qu'il sait FAIRE, sans jamais chercher un écran.
const doc = typeof document !== "undefined" ? document : null;

/* ── LE CACHET — un seul dessin, quatre degrés d'achèvement ─────────────── */

// Les mots du README anglais (carried, delivered, acknowledged). Le dernier
// ne tient pas sous le cachet : 90 px mesurés pour une case de 54. Le tampon
// porte donc la forme courte (`mot`) et la voix dit le mot entier (`dit`).
const CACHETS = {
  attente: { mot: "Waiting",   anneaux: 1, pointille: true,  barre: false },
  guichet: { mot: "Carried",   anneaux: 1, pointille: false, barre: false },
  recue:   { mot: "Delivered", anneaux: 2, pointille: false, barre: false },
  accusee: { mot: "Acked", dit: "Acknowledged", anneaux: 2, pointille: false, barre: true },
};

// Les quatre mots du PRODUIT (format.js, `ETATS_LISIBLES`) vers les quatre
// dessins. C'est le seul endroit de la page où un état se traduit.
const CLE_PAR_ETAT = {
  "en attente": "attente",
  "au guichet": "guichet",
  "reçue": "recue",
  "accusée": "accusee",
};

// À quel horodatage chaque état a été atteint. Le cachet porte l'heure DE SON
// ÉTAT — un pli accusé montre l'heure de l'accusé, pas celle du dépôt : c'est
// le dernier geste qui date le tampon.
const HORODATE_PAR_ETAT = {
  attente: "postee_a",
  guichet: "guichet_a",
  recue: "recue_a",
  accusee: "accusee_a",
};

// « reçue » et « accusée » portent des accents : composés autrement (é en deux
// points de code), la table ci-dessus les manquerait et tous les cachets
// tomberaient en « inconnu ». Une normalisation vaut mieux qu'un bug qui ne se
// voit que sur une machine.
export function normaliser(mot) {
  return String(mot ?? "").normalize("NFC").trim();
}

function echapper(valeur) {
  return String(valeur ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function heure(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function dessinerCachet(lettre) {
  const cle = CLE_PAR_ETAT[normaliser(lettre.etat)] || "inconnu";
  // UN CINQUIÈME MOT NE SE RANGE PAS DE FORCE. Si l'API rend un état que cette
  // page ne connaît pas, elle l'AFFICHE nu — sans anneau, sans encre. Le
  // ranger dans l'un des quatre dessins serait un cachet menteur, et un cachet
  // menteur est pire qu'un cachet vide.
  const c = CACHETS[cle] || { mot: normaliser(lettre.etat) || "?", anneaux: 0, pointille: false, barre: false };
  const h = heure(lettre[HORODATE_PAR_ETAT[cle]] || lettre.postee_a);

  const traits = [];
  if (c.anneaux > 0) {
    traits.push(
      `<circle cx="23" cy="23" r="21" fill="none" stroke="currentColor" stroke-width="1.6"${c.pointille ? ' stroke-dasharray="3 3.4"' : ""}/>`
    );
  }
  if (c.anneaux > 1) traits.push('<circle cx="23" cy="23" r="17" fill="none" stroke="currentColor" stroke-width="1"/>');
  if (c.barre) traits.push('<path d="M6.5 33 L39.5 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".85"/>');

  // L'`aria-label` dit l'état EN TOUTES LETTRES : le dessin porte toute la loi,
  // et qui ne le voit pas doit l'entendre en entier.
  return `<div class="cachet cachet--${cle}" role="img" aria-label="${echapper(c.dit || c.mot)} at ${echapper(h)}">
    <svg viewBox="0 0 46 46" aria-hidden="true">${traits.join("")}
      <text x="23" y="26.5" text-anchor="middle" font-family="DM Mono, monospace" font-size="10" font-weight="500" fill="currentColor">${echapper(h)}</text>
    </svg>
    <span class="cachet__mot">${echapper(c.mot)}</span>
  </div>`;
}

/* La légende rejoue le MÊME dessin, sans l'heure : quatre degrés d'un seul
   cachet. Le lecteur qui découvre la page comprend le voyage avant d'avoir
   lu une seule lettre. */
function peindreLegende() {
  const ordre = ["attente", "guichet", "recue", "accusee"];
  document.getElementById("legende").innerHTML = ordre
    .map((etat, i) => {
      const c = CACHETS[etat];
      const traits = [
        `<circle cx="23" cy="23" r="21" fill="none" stroke="currentColor" stroke-width="2"${c.pointille ? ' stroke-dasharray="3 3.4"' : ""}/>`,
        c.anneaux > 1 ? '<circle cx="23" cy="23" r="16" fill="none" stroke="currentColor" stroke-width="1.4"/>' : "",
        c.barre ? '<path d="M6.5 33 L39.5 13" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>' : "",
      ].join("");
      return `${i ? '<li class="legende__fleche" aria-hidden="true">→</li>' : ""}
      <li class="legende__item cachet--${etat}">
        <svg viewBox="0 0 46 46" aria-hidden="true">${traits}</svg>
        <span class="legende__mot">${c.mot}</span>
      </li>`;
    })
    .join("");
}

/* ── LE RÉSEAU — une seule porte, et elle connaît le 401 ────────────────── */

// Le jeton mort n'est pas une panne de réseau : il ne repoussera pas tout
// seul, et une page qui recommencerait toutes les trente secondes mentirait
// à l'humain qui attend. Il lui faut donc son propre chemin de sortie.
class SessionExpiree extends Error {}

async function demander(chemin, options = {}) {
  const reponse = await fetch(chemin, { credentials: "same-origin", ...options });
  if (reponse.status === 401) throw new SessionExpiree(chemin);
  let corps = null;
  try {
    corps = await reponse.json();
  } catch {
    corps = null; // un corps illisible n'est pas une raison de perdre le statut
  }
  return { ok: reponse.ok, statut: reponse.status, corps };
}

/* ── L'ÉTAT DE LA PAGE ──────────────────────────────────────────────────── */

// `?.` partout : hors navigateur ces prises valent `null`, et rien de ce qui
// dessine n'est appelé de toute façon (le branchement est au bas du fichier).
const fil = doc?.getElementById("fil");
const champ = doc?.getElementById("champ");
const boutonPoster = doc?.getElementById("poster");
const bandeau = doc?.getElementById("bandeau");
const etiquetteDestinataire = doc?.getElementById("destinataire");

// msg_id → { brut, element, local } — le pli VIT par son msg_id, jamais par sa
// place dans le fil : c'est le même identifiant que la lettre porte en base,
// donc un événement du flux retrouve toujours son papier.
const parId = new Map();

let moi = "";
let boites = [];
let choisie = null;
// LES CORRESPONDANTS — les noms qui apparaissent vraiment dans son courrier.
// Ils servent à UNE chose : ouvrir le composeur sur quelqu'un à qui il parle,
// plutôt que sur le premier nom de l'alphabet. Voir `choisirLaDestination`.
const correspondants = new Set();
let dernierJour = null;
let flux = null;
let minuteurReprise = null;
let ouverte = true; // faux dès que la session a expiré : plus rien ne repart

/* ── LES FORMES DE L'API, RAMENÉES À UNE SEULE ──────────────────────────── */

export function normaliserLettre(brut = {}) {
  return {
    msg_id: String(brut.msg_id ?? ""),
    seq: brut.seq ?? null,
    de: String(brut.de ?? brut.sender ?? ""),
    a: String(brut.a ?? brut.recipient ?? ""),
    objet: String(brut.objet ?? brut.subject ?? ""),
    corps: String(brut.corps ?? brut.body ?? ""),
    etat: String(brut.etat ?? ""),
    mien: Boolean(brut.mien),
    postee_a: brut.postee_a ?? brut.created_at ?? null,
    guichet_a: brut.guichet_a ?? null,
    recue_a: brut.recue_a ?? null,
    accusee_a: brut.accusee_a ?? null,
    type: String(brut.type ?? brut.msg_type ?? ""),
    priorite: String(brut.priorite ?? brut.priority ?? ""),
    // ⚠️ LA LOI DE L'ACCUSÉ EST CALCULÉE PAR L'API, PAS ICI. `geste_humain`
    // vaut `!accuseImplicite(row)` (serveur.js) : seule une lettre ordinaire
    // en priorité ordinaire est signée par la relève ; `broadcast`, `response`
    // et `status` exigent le geste. Le front la REDÉFINISSAIT (« task ou
    // priorité haute »), et les trois types ci-dessus tombaient dans une
    // impasse : le serveur refusait de signer, la page n'offrait pas de
    // signer, la lettre ne pouvait JAMAIS être accusée. Et comme la porte
    // inscrit l'opérateur au registre, CHAQUE diffusion de la maison y tombait.
    // Absente, la clef reste `null` : voir `attendUnAccuse` pour le sens.
    geste_humain: typeof brut.geste_humain === "boolean" ? brut.geste_humain : null,
    // Le cri (H2) voyage AVEC la lettre. La forme à clefs fixes le jetait —
    // tout un chantier rendu par l'API et perdu à un caractère de la fin.
    en_souffrance: brut.en_souffrance ?? null,
  };
}

export function normaliserBoite(brut = {}) {
  // ⚠️ LA CLEF EST `en_service`, ET C'EST LA SEULE. Le front cherchait
  // `brut.vivant` puis `brut.status` — deux noms que l'API n'écrit NULLE PART.
  // `String(undefined ?? "")` valant "", la chaîne de repli rendait `true`
  // TOUJOURS : une fiche retirée du service s'affichait vivante, voyant vert,
  // et la porte s'ouvrait pointée dessus. On lit donc la clef du bureau, et
  // rien d'autre : une seule loi, à un seul endroit.
  const enService = brut.en_service === true;
  return {
    nom: String(brut.nom ?? brut.id ?? ""),
    // Vivant ou hors service, la fiche RESTE à l'écran. Camp B est
    // constitutionnel : rien ne s'efface, pas même un nom dont plus personne
    // ne relève le courrier. Elle grise, elle ne disparaît pas.
    vivant: enService,
    // Le libellé du produit, tel quel : « in service », « retired from
    // service », « dead ». Le réécrire en « out of service » effacerait la
    // différence entre une chaise qu'on a rangée et une chaise qui est morte.
    libelle: String(brut.libelle ?? (enService ? "in service" : "out of service")),
    designee: Boolean(brut.designee ?? Number(brut.is_primary) === 1),
    // Les chaises en service, telles que l'API les compte : c'est le critère
    // du défaut du composeur (`choisirLaDestination`, « où il y a du monde »).
    // La fiche normalisée ne les portait pas, et le tri retombait sur
    // l'alphabet, juste par accident tant que l'alphabet était d'accord
    // (trouvé le 18/10, quand des noms d'exemple ont changé l'ordre).
    chaises: Number.isFinite(Number(brut.chaises)) ? Math.max(0, Math.trunc(Number(brut.chaises))) : 0,
    souffrance: compteDeSouffrance(brut.en_souffrance),
  };
}

/* ── L'EN-SOUFFRANCE (H2) — un cri se transmet, il ne se jette pas ──────── */

// Le cri d'une FICHE, ramené à un compte. ⚠️ L'API borne son en-souffrance
// des pairs au courrier de l'opérateur, et cette forme-là peut encore bouger :
// on lit donc toutes les formes plausibles sans jamais en exiger une. Une
// clef absente vaut zéro cri ; un cri sans compte reste UN cri (l'objet
// existe, c'est déjà l'information).
export function compteDeSouffrance(brut) {
  if (brut === null || brut === undefined) return 0;
  if (typeof brut === "number") return Number.isFinite(brut) ? Math.max(0, Math.trunc(brut)) : 0;
  if (typeof brut !== "object") return 0;
  const lettres = Number(brut.lettres);
  return Number.isFinite(lettres) ? Math.max(0, Math.trunc(lettres)) : 1;
}

// Le cri d'une LETTRE, en toutes lettres. Le vocabulaire est celui du produit
// (« en souffrance », le motif tel que le Facteur l'a écrit) : traduire le
// motif en langage d'écran ferait diverger deux vocabulaires, et c'est
// exactement la maladie qu'on soigne dans ce fichier.
export function ligneDeSouffrance(souffrance) {
  if (!souffrance || typeof souffrance !== "object") return "";
  const morceaux = ["Overdue"];
  const heures = Number(souffrance.depuis_h);
  if (Number.isFinite(heures)) morceaux.push(`for ${heures} h`);
  const tentatives = Number(souffrance.tentatives);
  if (Number.isFinite(tentatives) && tentatives > 0) {
    morceaux.push(`${tentatives} attempt${tentatives > 1 ? "s" : ""}`);
  }
  const ligne = morceaux.join(" · ");
  return souffrance.motif ? `${ligne} · ${souffrance.motif}` : ligne;
}

// LE CRI ET LE CACHET NE PEUVENT PAS SE CONTREDIRE. Une lettre accusée n'est
// JAMAIS en souffrance — ce n'est pas une règle d'écran, c'est le produit :
// `enSouffrance` (src/lib/format.js) rend `null` dès que `acked_at` est posé,
// et `lettresEnSouffrance` ne balaie que les lignes non accusées. La page ne
// recalcule donc rien ; elle lit le MOT d'état que l'API lui donne et refuse
// de peindre deux marques qui ne peuvent pas être vraies ensemble.
//
// Deuxième cadenas, et assumé comme tel : la cause du défaut du 22/08 est la
// retouche partielle (voir `retamponner`), pas cette fonction. Celle-ci ferme
// ce qui resterait ouvert si une charge incohérente arrivait un jour du flux —
// un cachet et un cri écrits par deux tours de calcul différents.
export function criDeLaLettre(l) {
  if (normaliser(l?.etat) === "accusée") return "";
  return ligneDeSouffrance(l?.en_souffrance);
}

/* ── LE PLAFOND DU FIL — une borne muette se lirait « tout est là » ─────── */

// L'API l'annonce EXPRÈS (`plafond`, `au_dela_du_plafond`) : les jeter, c'est
// faire disparaître des lettres sans un mot. Rien à dire quand rien ne manque
// — le silence des cas sains.
export function phraseDuPlafond(corps) {
  const manquantes = Number(corps?.au_dela_du_plafond);
  if (!Number.isFinite(manquantes) || manquantes <= 0) return null;
  const plafond = Number(corps?.plafond);
  const debut = `${manquantes} older letter${manquantes > 1 ? "s" : ""}`;
  const suite = manquantes > 1 ? "are not shown" : "is not shown";
  const borne = Number.isFinite(plafond) ? `. The page shows at most ${plafond}.` : ".";
  return `${debut} ${suite}${borne}`;
}

// LES ACCUSÉS QUE LA RELÈVE N'A PAS PU SIGNER.
//
// `/api/fil` rend `accuses_refuses` quand `ackMessage` a refusé de signer un
// accusé IMPLICITE (par exemple si la fiche de l'opérateur est retirée du service,
// `droitDAccuser` rend « destinataire retiré du service »). La lettre reste
// intacte et reviendra (A9) — mais la page n'en disait rien, et un pli qui
// aurait dû porter le tampon restait « reçue » sans que personne sache
// pourquoi. Même doctrine que le plafond : ce qui est tu se lit « tout va
// bien ». La clef est absente quand rien n'a été refusé — le silence des cas
// sains, et la carte est alors vide.
export function refusDesAccuses(corps) {
  const refuses = Array.isArray(corps?.accuses_refuses) ? corps.accuses_refuses : [];
  const parPli = new Map();
  for (const refus of refuses) {
    const id = String(refus?.msg_id ?? "");
    if (id) parPli.set(id, String(refus?.raison ?? "acknowledgement refused by the office"));
  }
  return parPli;
}

// Le flux et les routes peuvent envelopper leur charge ; on ne se fâche pas
// pour un nom de sac.
export function deballer(charge, ...noms) {
  if (Array.isArray(charge)) return charge;
  for (const nom of noms) {
    if (charge && charge[nom] !== undefined && charge[nom] !== null) return charge[nom];
  }
  return charge;
}

/* ── LES BOÎTES ─────────────────────────────────────────────────────────── */

// UNE FICHE EST UNE CHAÎNE AVANT D'ÊTRE UN BOUTON — même raison que le pli :
// ce qui s'affiche doit pouvoir se lire sans navigateur.
export function dessinerBoite(b, choisie = null) {
  // Le cri de la fiche : un compte à l'ocre de l'attente, et le mot en entier
  // pour qui ne voit pas la couleur.
  const cri = b.souffrance > 0
    ? `<span class="boite__souffrance" aria-label="${b.souffrance} overdue">${b.souffrance}</span>`
    : "";
  return `
    <li>
      <button type="button" class="boite${b.vivant ? "" : " boite--morte"}"
              aria-pressed="${b.nom === choisie}" data-nom="${echapper(b.nom)}">
        <span class="boite__voyant"></span>${echapper(b.nom)}${
          b.vivant ? "" : `<span class="lecteur-seul"> — ${echapper(b.libelle)}</span>`
        }${cri}${b.designee ? '<span class="boite__designee">Designated</span>' : ""}
      </button>
    </li>`;
}

function peindreBoites() {
  const html = destinations(boites, moi).map((b) => dessinerBoite(b, choisie)).join("");
  doc.getElementById("boites-haut").innerHTML = html;
  doc.getElementById("boites-cote").innerHTML = html;
  etiquetteDestinataire.textContent = choisie || "—";
  peindreLeGuichet();
}

// LE GUICHET DIT S'IL EST OUVERT. Fermé, il ne se contente pas de refuser sous
// le doigt : il explique, et il éteint le bouton pour que le refus se VOIE
// avant d'être essayé. La session expirée reste maîtresse du bouton — elle
// ferme pour une autre raison, et une raison qui repousse l'autre serait une
// page qui ment sur ce qui la bloque.
function peindreLeGuichet() {
  const etat = etatDuGuichet(boites, choisie, moi);
  const prise = doc?.getElementById("guichet-ferme");
  if (prise) {
    prise.textContent = etat.raison || "";
    prise.hidden = etat.ouvert;
  }
  // ET LA LIGNE DU FIL VIDE SUIT LE MÊME ÉTAT. Le registre bouge sans que le
  // fil se repeigne (une boîte qui s'inscrit arrive par le flux `pairs`) :
  // sans cette ligne, la page redeviendrait contradictoire à la première
  // inscription — et le contraire aussi, à la dernière désinscription.
  const vide = fil?.querySelector(".fil__vide");
  if (vide) vide.textContent = phraseDuFilVide(etat);
  if (!ouverte) return;
  if (champ) champ.disabled = !etat.ouvert;
  if (boutonPoster) boutonPoster.disabled = !etat.ouvert;
}

// SA PROPRE BOÎTE N'EST PAS UNE DESTINATION. La porte inscrit l'opérateur au
// registre (il faut une fiche pour recevoir), et sur un bureau neuf c'était la
// seule en service : la page s'ouvrait pointée sur lui-même. On l'écarte des
// DESTINATIONS — pas du registre : la fiche existe, elle reçoit, elle n'est
// simplement pas une adresse à qui l'on écrit.
export function destinations(boites, quiEcrit = null) {
  return boites.filter((b) => !quiEcrit || b.nom !== quiEcrit);
}

// L'ÉTAT DU GUICHET, DIT AVANT D'ÊTRE POSÉ.
//
// Sur un bureau NEUF, la porte inscrit l'opérateur et c'est la seule fiche :
// aucune destination possible (`choisirLaDestination` rend `null`), et le
// `if (!texte || !choisie) return;` du composeur renvoyait le doigt de
// l'opérateur dans le vide, sans un mot. Un bouton qui ne fait rien sans le dire
// est le pire état d'une interface — pire qu'une erreur, parce qu'on croit
// avoir mal appuyé.
//
// Le registre de la maquette : une erreur n'accuse pas, n'excuse pas, dit ce
// qui s'est passé et quoi faire. Donc le fait, puis le geste.
//
// ⚠️ UNE BOÎTE ENDORMIE NE FERME PAS LE GUICHET. Écrire à une fiche hors
// service reste permis — la lettre attendra, elle ne se perdra pas (A9) — et
// fermer là serait retirer un droit, pas prévenir d'un vide.
export function etatDuGuichet(boites, choisie = null, quiEcrit = null) {
  if (choisie) return { ouvert: true, raison: null };
  if (destinations(boites || [], quiEcrit).length > 0) {
    // Il y a des boîtes, aucune n'est choisie : ce n'est pas un bureau vide,
    // c'est un choix qui manque. On dit CE fait-là, pas l'autre.
    return { ouvert: false, raison: "Choose a mailbox in the registry before writing." };
  }
  return {
    ouvert: false,
    raison:
      "No mailbox to write to: the registry holds only your card. " +
      "A session must register with the office to receive mail."
  };
}

// Le choix de l'humain survit à une repeinture du registre : une boîte qui
// meurt pendant qu'on lui écrit reste la destinataire, elle grise seulement.
// La lettre attendra, elle ne se perdra pas (A9). On ne rechoisit donc que
// quand le choix courant n'est plus une destination — ou qu'il n'y en a pas.
export function choisirLaDestination(boites, choisie = null, quiEcrit = null, correspondants = null) {
  const possibles = destinations(boites, quiEcrit);
  if (choisie && possibles.some((b) => b.nom === choisie)) return choisie;

  // ⚠️ « LA PREMIÈRE BOÎTE VIVANTE » N'EST PAS UN CRITÈRE, C'EST UN TRI.
  // À la première ouverture, le composeur s'est ouvert sur un nom de MACHINE,
  // né du repli sur le nom d'hôte quand
  // une session ne dérive pas de nom propre, et qui passe devant tout le monde
  // parce qu'une majuscule trie avant une minuscule. Écrire à son propre Mac
  // par défaut, dans sa propre boîte, n'a aucun sens.
  //
  // Le bon défaut n'est pas alphabétique : c'est QUELQU'UN À QUI IL PARLE
  // DÉJÀ. Les correspondants viennent de son fil — les noms qui apparaissent
  // vraiment dans son courrier.
  if (correspondants && correspondants.size > 0) {
    const connu = possibles.find((b) => b.vivant && correspondants.has(b.nom));
    if (connu) return connu.nom;
  }

  // Aucun correspondant : alors la lignée la plus VIVANTE, celle qui porte le
  // plus de chaises. C'est un critère — « une famille où il y a du monde » —
  // là où « la première » n'en était pas un. Départage stable par le nom pour
  // qu'un même registre rende toujours la même réponse.
  const vivantes = possibles
    .filter((b) => b.vivant)
    .sort((a, b) => (b.chaises || 0) - (a.chaises || 0) || a.nom.localeCompare(b.nom));
  // Et à défaut de vivante, la première du registre : écrire à une boîte
  // endormie reste permis (la lettre attendra, A9), c'est seulement un défaut
  // médiocre — jamais une porte fermée.
  return (vivantes[0] || possibles[0] || {}).nom || null;
}

function appliquerLesPairs(charge) {
  const brutes = deballer(charge, "pairs", "boites", "peers") || [];
  boites = (Array.isArray(brutes) ? brutes : []).map(normaliserBoite).filter((b) => b.nom);
  choisie = choisirLaDestination(boites, choisie, moi, correspondants);
  peindreBoites();
}

doc?.addEventListener("click", (e) => {
  const b = e.target.closest(".boite");
  if (!b) return;
  choisie = b.dataset.nom;
  peindreBoites();
});

/* ── LE FIL ─────────────────────────────────────────────────────────────── */

function jourLisible(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // La langue du jour est celle du navigateur, comme l'heure du cachet.
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function placerLeJour(iso) {
  const jour = jourLisible(iso);
  if (!jour || jour === dernierJour) return;
  dernierJour = jour;
  const p = document.createElement("p");
  p.className = "fil__jour";
  p.textContent = jour;
  fil.append(p);
}

// QUI DÉFILE N'EST PAS TOUJOURS LE MÊME. Au large, la maquette met le fil dans
// une grille à hauteur fixe : c'est LE FIL qui défile. Sur téléphone, le corps
// s'allonge et c'est LA PAGE. Viser toujours `fil.scrollTop` marche donc au
// bureau et ne fait rien du tout sur un client mobile — et la porte s'ouvrirait sur la
// lettre la plus VIEILLE, sur l'appareil pour lequel elle est faite.
function leDefileur() {
  return fil.scrollHeight > fil.clientHeight + 1 ? fil : document.scrollingElement;
}

// Ne pas arracher la lecture : on ne suit le bas du fil que si on y était
// déjà. Une lettre qui arrive pendant qu'on relit celle d'hier ne doit pas
// faire sauter la page.
function presDuBas() {
  const d = leDefileur();
  return d.scrollHeight - d.scrollTop - d.clientHeight < 120;
}

function filerEnBas() {
  const d = leDefileur();
  d.scrollTop = d.scrollHeight;
}

function retirerLeVide() {
  fil.querySelector(".fil__vide")?.remove();
}

// UN FIL VIDE DIT LA MÊME CHOSE QUE LE GUICHET, OU IL SE TAIT SUR L'ÉCRITURE.
//
// Sur un bureau NEUF, la page tenait deux discours à dix centimètres l'un de
// l'autre : le fil « Écris la première » et, juste dessous, le guichet fermé
// qui explique qu'il n'y a personne à qui écrire — champ éteint, bouton
// éteint. Deux messages qui se contredisent dans la même page valent moins que
// zéro message : le lecteur croit avoir mal fait quelque chose.
//
// Le remède ne consiste PAS à devenir muet : quand écrire est possible,
// l'invitation est vraie et elle reste. C'est la raison du GUICHET qui prend
// la suite quand il est fermé — reprise mot pour mot, pas reformulée : deux
// phrases pour un seul fait finissent toujours par diverger.
export function phraseDuFilVide(etat) {
  if (etat?.ouvert !== false) return "No letters yet. Write the first one.";
  return `No letters yet. ${etat.raison}`;
}

function poserLeVide() {
  const p = document.createElement("p");
  p.className = "fil__vide";
  p.textContent = phraseDuFilVide(etatDuGuichet(boites, choisie, moi));
  fil.append(p);
}

/* ── LE PLI ─────────────────────────────────────────────────────────────── */

export function attendUnAccuse(l) {
  if (l.mien) return false; // on n'accuse pas réception de son propre courrier
  if (normaliser(l.etat) !== "reçue") return false; // ni avant l'arrivée, ni après le tampon
  // LA PAGE LIT, ELLE NE JUGE PAS. `geste_humain` vient de l'API, qui l'a
  // dérivé de la MÊME fonction que la relève (`accuseImplicite`) : c'est ce
  // qui garantit que le bouton s'offre exactement là où le serveur refuse de
  // signer à la place de l'humain.
  // Absente (`null`), la clef n'est pas une permission de deviner : on offre
  // le bouton. Le prix n'est pas symétrique — une lettre qu'on peut signer
  // pour rien coûte un clic, une lettre qu'on ne peut PAS signer est éteinte
  // pour toujours, et le bureau, lui, motive son refus.
  return l.geste_humain !== false;
}

export function pied(l, local) {
  const morceaux = [];
  if (local.nonPartie) {
    morceaux.push('<span class="pli__avarie">Not sent.</span>');
    // « Réessayer » ne s'offre QUE si un rejeu peut réussir. Sur un refus
    // motivé du bureau (4xx), le même pli au même octet près recevrait le même
    // refus : le bouton promettrait ce qu'il ne peut pas tenir, et c'est le
    // motif — affiché juste dessous — qui dit quoi faire à la place.
    if (local.rejouable !== false) {
      morceaux.push('<button type="button" class="bouton-discret" data-reprise>Retry</button>');
    }
  } else if (attendUnAccuse(l) && !local.accuseEnvoye && local.accuseRejouable !== false) {
    // `accuseRejouable` PORTE LA MÊME LOI QUE `rejouable` CI-DESSUS (5e passe
    // adverse). `accuser` éteint son bouton, puis `rafraichirLePied` redessine
    // le pied — et le bouton revenait RÉACTIVÉ, juste au-dessus du motif qui
    // explique que le même clic recevra le même refus. Un bouton qui invite à
    // refaire ce qui vient d'échouer use la confiance plus vite qu'une erreur.
    // Seul `false` retire : absent, on offre — une panne se rejoue, un
    // jugement du bureau non.
    morceaux.push('<button type="button" class="bouton-discret" data-accuser>Acknowledge</button>');
  } else if (local.accuseEnvoye && normaliser(l.etat) !== "accusée") {
    morceaux.push("<span>Acknowledgement sent.</span>");
  }
  if (local.refus) morceaux.push(`<span class="pli__refus">${echapper(local.refus)}</span>`);
  // Le refus d'un accusé IMPLICITE : la relève n'a pas pu signer à la place de
  // l'opérateur, et l'API le dit (`accuses_refuses`). Même encre que les autres
  // refus — c'est le même genre de nouvelle, et la lettre reviendra (A9).
  if (local.refusDeLaReleve) {
    morceaux.push(`<span class="pli__refus">Automatic acknowledgement refused: ${echapper(local.refusDeLaReleve)}</span>`);
  }
  // LE REJEU SE DIT CALMEMENT. Ce n'est pas une avarie : c'est l'idempotence
  // qui a fait exactement son travail. Il a donc sa propre encre, celle du
  // pli, jamais le rouge des refus.
  if (local.note) morceaux.push(`<span class="pli__note">${echapper(local.note)}</span>`);
  if (!morceaux.length) return "";
  return `<div class="pli__pied">${morceaux.join("")}</div>`;
}

function corpsEnParagraphes(corps) {
  return String(corps)
    .split(/\n{2,}/)
    .filter((bloc) => bloc.trim() !== "")
    .map((bloc) => `<p class="pli__corps">${echapper(bloc).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// LE PLI EST UNE CHAÎNE AVANT D'ÊTRE UN ÉLÉMENT. Le dessin est séparé de la
// pose pour qu'un test puisse le LIRE sans navigateur : ce qui s'affiche est
// alors une chose qu'on prouve, pas une chose qu'on croit.
export function dessinerPli(l, local) {
  // L'EN-SOUFFRANCE SE POSE SUR LA LIGNE D'EXPÉDITEUR, qui existait déjà :
  // c'est là que le lecteur cherche « d'où vient ce pli, et où en est-il ».
  // Elle est ORTHOGONALE au cachet (une lettre « reçue » peut être en
  // souffrance) — d'où deux marques, jamais un cinquième état.
  const cri = criDeLaLettre(l);
  return `
    <div class="pli__tete">
      <div class="pli__de"><b>${echapper(l.de)}</b>to ${echapper(l.a)}${
        cri ? `<span class="pli__souffrance">${echapper(cri)}</span>` : ""
      }</div>
      ${dessinerCachet(l)}
    </div>
    ${l.objet ? `<p class="pli__objet">${echapper(l.objet)}</p>` : ""}
    ${corpsEnParagraphes(l.corps)}
    ${pied(l, local)}`;
}

export function classesDuPli(l, local) {
  return `pli${l.mien ? " pli--mien" : ""}${local.nonPartie ? " pli--nonpartie" : ""}`;
}

function peindrePli(entree) {
  const l = normaliserLettre(entree.brut);
  entree.element.className = classesDuPli(l, entree.local);
  entree.element.innerHTML = dessinerPli(l, entree.local);
}

// LE COUP DE TAMPON REDESSINE TOUT LE PLI, ET C'EST LE REMÈDE DU 22/08.
//
// Il refaisait le cachet et le pied — deux morceaux NOMMÉS À LA MAIN — et
// laissait sur le papier tout ce qu'il n'avait pas nommé. Mesuré : une
// diffusion de neuf heures passe de « reçue » à « accusée », la base cesse de
// crier (`enSouffrance` rend nul dès que `acked_at` est posé), et l'écran
// affichait « Accusée » ET « En souffrance depuis 9 h » sur la MÊME lettre —
// le cri vit dans la tête du pli, que ce geste ne touchait pas.
//
// La cause n'est pas le cri : c'est la RETOUCHE PARTIELLE. Tout morceau ajouté
// au pli demain retomberait dans le même trou, en silence. On repasse donc par
// l'unique peintre (`dessinerPli`), et le geste ne garde de son ancienne forme
// que ce qui la justifiait : la frappe se voit tomber.
//
// Ce qu'on paie, dit à voix haute : les nœuds du corps sont recréés, donc une
// sélection de texte en cours sur CE pli-là se perd au moment du tampon. Un
// écran qui se contredit coûte infiniment plus cher qu'une sélection perdue —
// et c'est la seule chose qu'une démonstration ne pardonne pas.
export function retamponner(entree) {
  peindrePli(entree);
  entree.element.querySelector(".cachet")?.classList.add("cachet--frappe");
}

function rafraichirLePied(entree) {
  const l = normaliserLettre(entree.brut);
  const neuf = pied(l, entree.local);
  const ancien = entree.element.querySelector(".pli__pied");
  if (ancien && !neuf) return ancien.remove();
  if (ancien) return ancien.outerHTML = neuf;
  if (neuf) entree.element.insertAdjacentHTML("beforeend", neuf);
}

function deposer(brut) {
  const l = normaliserLettre(brut);
  retirerLeVide();
  placerLeJour(l.postee_a);
  const element = document.createElement("article");
  element.dataset.msgId = l.msg_id;
  const entree = {
    brut,
    element,
    local: { nonPartie: false, refus: null, rejouable: true, accuseEnvoye: false, note: null, refusDeLaReleve: null }
  };
  peindrePli(entree);
  fil.append(element);
  parId.set(l.msg_id, entree);
  return entree;
}

// Une lettre qui revient (l'écho de mon propre envoi, une relecture du fil) ne
// se dépose pas une deuxième fois : elle MET À JOUR son papier, sur place.
function accueillir(brut) {
  const l = normaliserLettre(brut);
  if (!l.msg_id) return null;
  const entree = parId.get(l.msg_id);
  if (!entree) {
    const suivait = presDuBas();
    const neuve = deposer(brut);
    if (suivait) filerEnBas();
    return neuve;
  }
  const avant = normaliser(normaliserLettre(entree.brut).etat);
  entree.brut = { ...entree.brut, ...brut };
  entree.local.nonPartie = false; // le bureau l'a : elle est partie
  if (normaliser(normaliserLettre(entree.brut).etat) !== avant) retamponner(entree);
  else peindrePli(entree);
  return entree;
}

// LE PLAFOND SE DIT. L'API l'annonce exprès (`plafond`, `au_dela_du_plafond`)
// et la page n'en faisait rien : avec 505 lettres, 5 disparaissaient sans un
// mot. La ligne se pose EN TÊTE du fil — c'est là que les disparues
// manqueraient, le fil se lit du plus vieux au plus récent.
function poserLePlafond(phrase) {
  // Une seule ligne, toujours : la relève repasse ici à chaque arrivée, et
  // deux annonces empilées se liraient comme deux troncatures.
  fil.querySelector(".fil__plafond")?.remove();
  if (!phrase) return;
  const p = document.createElement("p");
  p.className = "fil__plafond";
  p.textContent = phrase;
  fil.prepend(p);
}

// L'ACCUSÉ QUE LA RELÈVE N'A PAS PU SIGNER SE POSE SUR SON PLI. Il arrive à
// CHAQUE relève tant que la cause dure (la fiche reste hors service) : la
// carte est donc réappliquée à chaque fois, et un pli qui n'y est plus perd
// sa marque tout seul — sinon un motif éteint resterait à l'écran pour
// toujours, ce qui est la même maladie dans l'autre sens.
//
// ⚠️ LE CASIER EST INJECTABLE, ET SEULEMENT POUR ÇA (même raison que
// `surLettreDuFlux` : les actions ne s'injectent que pour qu'un test puisse
// les REGARDER sans navigateur, jamais pour déplacer la décision). Son seul
// verrou était un grep de la source — vert même si la pose n'arrivait jamais
// sur un papier. La décision reste ici ; c'est l'EFFET qui devient observable.
export function poserLesAccusesRefuses(corps, casier = parId) {
  const parPli = refusDesAccuses(corps);
  for (const [msgId, entree] of casier) {
    const avant = entree.local.refusDeLaReleve || null;
    // ⚠️ SON PROPRE CHAMP, ET PAS `local.refus`. Le refus d'un accusé que
    // l'opérateur a signé À LA MAIN vit dans `refus` : partager le champ ferait
    // que chaque relève efface son motif, ou pire, le garde après coup.
    entree.local.refusDeLaReleve = parPli.get(msgId) || null;
    if (entree.local.refusDeLaReleve !== avant) rafraichirLePied(entree);
  }
}

function peindreLeFil(corps) {
  const lettres = Array.isArray(corps?.lettres) ? corps.lettres : [];
  // Les deux sens comptent : celui qui lui écrit comme celui à qui il a écrit.
  // On n'efface jamais — un correspondant d'hier reste un correspondant, même
  // si son courrier du jour est vide.
  for (const l of lettres) {
    for (const nom of [l?.de, l?.a]) {
      if (nom && nom !== moi) correspondants.add(String(nom));
    }
  }
  // La repeinture complète se fait sous `aria-busy` : sans ça, un simple
  // rechargement ferait relire tout le fil à voix haute par un lecteur d'écran.
  fil.setAttribute("aria-busy", "true");
  fil.textContent = "";
  parId.clear();
  dernierJour = null;
  if (!lettres.length) poserLeVide();
  else for (const brut of lettres) deposer(brut);
  poserLePlafond(phraseDuPlafond(corps));
  poserLesAccusesRefuses(corps);
  requestAnimationFrame(() => {
    fil.setAttribute("aria-busy", "false");
    filerEnBas();
  });
}

function poserAvis(message) {
  const el = document.createElement("div");
  // Le message est celui de l'API, MOT POUR MOT (`avisDAttente`,
  // src/facteur/round.js) : le produit explique sa propre loi mieux qu'une
  // phrase d'écran qui la résumerait. Seule l'amorce en gras est de la maison.
  el.className = "avis";
  el.innerHTML = `<span><b>This letter will wait.</b> ${echapper(message)}</span>`;
  fil.append(el);
  filerEnBas();
}

/* ── LES RELEVÉS ────────────────────────────────────────────────────────── */

// LE NOM DE LA MACHINE QUI SERT LA PAGE. Aucune surface de l'API ne le porte,
// mais l'URL le fait. Un nom pleinement qualifié se réduit à son premier
// label ; une adresse ou `localhost` reste telle quelle. Aucun défaut n'entre
// ici : une valeur de secours serait le nom d'une autre machine.
export function nomDeLaMachine(hote) {
  const ecrit = String(hote ?? "").trim();
  if (!ecrit) return "";
  if (ecrit === "localhost" || ecrit.includes(":")) return ecrit;
  if (/^\d+(?:\.\d+){3}$/.test(ecrit)) return ecrit;
  return ecrit.split(".")[0];
}

async function chargerLesPairs() {
  const { ok, corps } = await demander("/api/pairs");
  if (!ok) throw new Error(`GET /api/pairs → ${corps ? JSON.stringify(corps) : "refused by the office"}`);
  appliquerLesPairs(corps);
}

// La sous-marque porte les DEUX : le nom de l'opérateur et celui de la machine.
// Le chargement n'écrit que dans la moitié qui le regarde — écraser la ligne
// entière avec `moi` ferait disparaître la machine.
function direQuiEtOu(nom) {
  const prise = doc?.getElementById("marque-sous");
  if (prise && nom) prise.textContent = nom;
  const machine = doc?.getElementById("marque-machine");
  // `typeof` et pas `location?.` : hors navigateur, `location` n'est pas une
  // variable nulle, c'est une variable qui n'EXISTE pas — l'optionnel ne
  // protège de rien et la ligne lèverait.
  const hote = typeof location === "undefined" ? "" : location.hostname;
  if (machine) machine.textContent = nomDeLaMachine(hote);
}

// ⚠️ CETTE ROUTE RELÈVE (contrat : `markDelivered` sur les non-livrées). On ne
// l'appelle donc que quand la page LIT vraiment : au chargement, au retour
// d'une coupure, et à l'arrivée d'une lettre — jamais en boucle de confort.
async function demanderLeFil() {
  const { ok, corps } = await demander("/api/fil");
  if (!ok) throw new Error(`GET /api/fil → ${corps ? JSON.stringify(corps) : "refused by the office"}`);
  if (corps?.moi) moi = corps.moi;
  direQuiEtOu(corps?.moi);
  return corps || {};
}

async function chargerLeFil() {
  peindreLeFil(await demanderLeFil());
}

/* ── LA RELÈVE DE CE QUI VIENT D'ARRIVER ────────────────────────────────── */
//
// ⚠️ `/api/fil` EST LA SEULE SURFACE QUI RELÈVE. Le flux, lui, ne fait que
// raconter : sur un événement `lettre`, la page peignait le pli et s'arrêtait
// là — l'opérateur lisait une lettre que la base croyait encore en chemin
// (`carried_at`, `delivered_at`, `acked_at` tous nuls). Le cachet mentait à
// l'écran et l'expéditeur n'avait jamais son tampon.
//
// Deux pièges évités :
//   ① PAS DE REPEINTURE. `peindreLeFil` vide le fil : elle emporterait les
//     plis qui ne sont pas encore partis (ils n'existent qu'à l'écran) et
//     ferait clignoter la lettre qu'on est en train de lire. On FUSIONNE donc,
//     pli par pli, par msg_id.
//   ② PAS DE BOUCLE DE CONFORT. Une relève à l'arrivée, pas une toutes les
//     N secondes. Les arrivées d'un même tour se rassemblent en un seul
//     relevé, et un relevé demandé pendant qu'un autre vole en déclenche
//     exactement un de plus — jamais une file.
let releveEnVol = false;
let releveARejouer = false;

async function releverLeCourrier() {
  const corps = await demanderLeFil();
  for (const brut of Array.isArray(corps.lettres) ? corps.lettres : []) accueillir(brut);
  poserLePlafond(phraseDuPlafond(corps));
  poserLesAccusesRefuses(corps);
}

async function programmerLaReleve() {
  if (releveEnVol) {
    releveARejouer = true;
    return;
  }
  releveEnVol = true;
  try {
    await releverLeCourrier();
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    // Une relève ratée n'est pas une panne du fil : le prochain événement, ou
    // la prochaine reprise, la rejouera. On ne crie pas pour ça.
  } finally {
    releveEnVol = false;
  }
  if (releveARejouer) {
    releveARejouer = false;
    await programmerLaReleve();
  }
}

/* ── LE GUICHET — poster, et rejouer la MÊME lettre ─────────────────────── */

// La clef d'idempotence naît ICI, et c'est exactement à ça qu'elle sert : un
// rejeu au même msg_id rend la ligne EXISTANTE (remède R2, src/lib/guichet.js),
// jamais une deuxième lettre. D'où le préfixe `msg-`, celui de
// `generateMessageId` — deux surfaces qui nomment autrement finissent par se
// croire deux bureaux.
function nouvelIdentifiant() {
  // `crypto.randomUUID` n'existe qu'en contexte sûr. La porte s'ouvre en https
  // par une façade amont, mais une visite en clair sur le port nu casserait
  // TOUT le composeur pour une seule fonction manquante — d'où le repli, sur
  // la même source d'aléa.
  if (typeof crypto.randomUUID === "function") return `msg-${crypto.randomUUID()}`;
  const octets = crypto.getRandomValues(new Uint8Array(16));
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  const hex = [...octets].map((o) => o.toString(16).padStart(2, "0")).join("");
  return `msg-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// UN ÉCHEC QUI NE DIT PAS POURQUOI EST PIRE QU'UN ÉCHEC. Le bureau motive ses
// refus (`refus` + `motif`) et la page les jetait : « Non partie. » et un
// bouton « Réessayer » qui rejouerait le même refus pour toujours.
//   • 4xx = le bureau a jugé CETTE lettre-là. La rejouer à l'octet près
//     donnerait exactement le même refus : le bouton mentirait, on le retire
//     et on montre le motif — c'est lui qui dit quoi faire.
//   • 5xx ou pas de réponse du tout = une panne. Là, la reprise a un sens, et
//     c'est à ça que sert le msg_id d'idempotence (un rejeu ne crée jamais
//     une deuxième lettre).
export function avarieDuRefus(statut, corps) {
  const motif = corps?.motif || corps?.raison || corps?.refus || null;
  const jugee = Number(statut) >= 400 && Number(statut) < 500;
  return {
    motif: motif || "The office did not answer.",
    rejouable: !jugee
  };
}

// CE QUE LA RÉPONSE DU DÉPÔT APPREND À LA PAGE — et qu'elle ne lisait PAS.
//
// L'API rend `msg_id`, `rejeu` et `clef_ecartee` EXPRÈS (serveur.js le dit
// noir sur blanc : « elle exige que le front adopte le msg_id rendu par la
// réponse »). La page n'en lisait aucun, elle ne prenait que `seq`.
//
// ① `msg_id` FAIT FOI. La page génère une clef et la garde comme identité
//    locale du pli — mais la porte peut avoir déposé sous une AUTRE quand la
//    clef proposée était déjà prise par du courrier qui n'est pas le sien. Le
//    pli restait alors classé sous une clef que le bureau ne connaît pas :
//    l'écho du flux ne retrouvait plus le papier et en déposait un SECOND. La
//    lettre se dédoublait à l'écran, et la première moitié restait « en
//    attente » pour toujours.
//
// ② `rejeu` et `clef_ecartee` NE SE CONFONDENT PAS. Le guichet les a séparés
//    exprès (guichet.js ⑧) et une surface qui les refond perd l'information :
//      · `rejeu` = « cette lettre existait déjà, ton renvoi n'en a pas créé
//        une deuxième ». C'est l'idempotence qui FONCTIONNE : ça se dit
//        calmement, sur le pli, et ça n'alarme personne.
//      · `clef_ecartee` = « la clef que la page avait choisie appartenait à
//        du courrier qui n'est pas le tien ». La lettre est partie quand même
//        (A8 : un doublon vaut mieux qu'une lettre perdue), mais l'identité
//        que la page tenait était FAUSSE. C'est un accident, pas une loi : ça
//        se dit fort, au bandeau, et le texte reste à l'écran.
export function suiteDuDepot(corps, msgIdLocal) {
  const rendu = String(corps?.msg_id ?? "").trim();
  const msgId = rendu || String(msgIdLocal ?? "");
  // La PRÉSENCE de la clef suffit : `demandee` pourrait être vide un jour, et
  // un écart mesuré à la longueur d'une chaîne serait un écart qu'on rate.
  const ecartee = Boolean(corps?.clef_ecartee);
  return {
    msgId,
    // Reclasser, et pas seulement renommer : le pli vit par son msg_id dans
    // `parId`, un nom changé sans casier changé le rendrait introuvable.
    reclasser: Boolean(rendu) && rendu !== String(msgIdLocal ?? ""),
    note: corps?.rejeu
      ? "This letter was already at the office: sending it again did not duplicate it."
      : null,
    alerte: ecartee
      ? "The identifier this page chose already belonged to mail that is not yours. " +
        "The letter was sent under another identifier, and the office's identifier is the one that counts."
      : null
  };
}

// LE PLI CHANGE DE CASIER, PAS SEULEMENT DE NOM. Il vit par son msg_id dans
// `parId` ET dans `data-msg-id` (le clic sur « Réessayer » et « Accuser » lit
// celui-là) : renommer l'un sans l'autre rendrait le papier injoignable des
// deux côtés à la fois.
//
// ⚠️ CE GESTE EST CELUI QUE `suiteDuDepot` JUSTIFIE, et il n'était verrouillé
// NULLE PART (5e passe adverse) : la DÉCISION était éprouvée, le geste non.
// C'est pourtant lui qui empêche le dédoublement — sans casier changé, l'écho
// du flux arrive sous la clef du bureau, ne trouve aucun papier, et
// `accueillir` en dépose un SECOND. Le casier s'injecte pour la même raison
// que celui de `poserLesAccusesRefuses` : pour qu'un test puisse le regarder
// sans navigateur, jamais pour déplacer la décision.
export function reclasserLePli(entree, ancienId, neufId, casier = parId) {
  if (!neufId || neufId === ancienId) return;
  casier.delete(ancienId);
  casier.set(neufId, entree);
  entree.element.dataset.msgId = neufId;
}

async function envoyer(msgId) {
  const entree = parId.get(msgId);
  if (!entree) return;
  const l = normaliserLettre(entree.brut);
  entree.local.refus = null;
  entree.local.rejouable = true;
  try {
    const { ok, statut, corps } = await demander("/api/poster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `de` n'est pas un paramètre : la porte signe l'opérateur configuré
      // (contrat). Le front ne le propose donc même pas.
      body: JSON.stringify({ a: l.a, corps: l.corps, type: "message", msg_id: l.msg_id }),
    });
    if (!ok) {
      // LE MOTIF NE SE JETTE PAS. Il était perdu dans un `Error` que le `catch`
      // ne lisait pas : l'écran disait « Non partie. » et rien de plus, pour un
      // refus que le bureau avait pris la peine d'expliquer.
      const avarie = avarieDuRefus(statut, corps);
      entree.local.nonPartie = true;
      entree.local.refus = avarie.motif;
      entree.local.rejouable = avarie.rejouable;
      peindrePli(entree);
      return;
    }
    entree.local.nonPartie = false;
    // ⚠️ LA RÉPONSE DU BUREAU FAIT FOI, Y COMPRIS SUR L'IDENTITÉ DU PLI.
    const suite = suiteDuDepot(corps, l.msg_id);
    entree.brut = {
      ...entree.brut,
      ...(corps?.seq ? { seq: corps.seq } : {}),
      ...(suite.reclasser ? { msg_id: suite.msgId } : {})
    };
    if (suite.reclasser) reclasserLePli(entree, l.msg_id, suite.msgId);
    entree.local.note = suite.note;
    peindrePli(entree);
    // Une clef écartée n'est pas une loi qui tient, c'est un accident : elle
    // passe par le canal fort. Un rejeu, lui, reste sur le pli — calmement.
    if (suite.alerte) direAuBandeau(suite.alerte, "ecart");
    // L'avis 2-bis : quand la lettre va attendre, on le DIT, avec les mots du
    // bureau, tels quels. Silence quand elle est livrable — le silence des cas
    // sains. (La page redressait l'avis « inconnu du registre » d'une fiche
    // retirée du service en le coupant sur « : ». Depuis le 18/10 le bureau dit
    // « No peer in service answers to this name », ce qui est vrai de cette
    // fiche-là : plus rien à redresser, et plus de prose à découper.)
    if (corps?.attente?.message) poserAvis(corps.attente.message);
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    // LA LETTRE RESTE À L'ÉCRAN. L'effacer parce que le réseau a toussé, c'est
    // la perdre — le texte est encore là, le msg_id aussi, et « Réessayer »
    // rejoue exactement la même. Rien ne se perd, y compris ici.
    // Ici le bureau n'a pas répondu du tout : la reprise a un sens.
    const avarie = avarieDuRefus(0, null);
    entree.local.nonPartie = true;
    entree.local.refus = avarie.motif;
    entree.local.rejouable = avarie.rejouable;
    peindrePli(entree);
  }
}

doc?.getElementById("guichet")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const texte = champ.value.trim();
  // LE GUICHET FERMÉ SE DIT, IL NE SE TAIT PAS. Le bouton est déjà éteint dans
  // ce cas ; le clavier (Entrée) peut encore arriver ici, et le refus muet
  // serait exactement le défaut qu'on répare.
  const etat = etatDuGuichet(boites, choisie, moi);
  if (!etat.ouvert) {
    peindreLeGuichet();
    return;
  }
  // Un champ vide n'est pas une panne : il n'y a rien à dire, et rien à dire
  // sur le fait qu'il n'y a rien à dire.
  if (!texte) return;
  champ.value = "";
  champ.style.height = "auto";
  // Le pli se pose AVANT la réponse du bureau, avec le seul état qu'une lettre
  // qu'on vient d'écrire puisse avoir : « en attente », par définition (aucun
  // horodatage encore posé). Dès que le bureau parle — réponse du POST ou
  // événement du flux — c'est SON mot qui écrase celui-ci.
  const entree = deposer({
    msg_id: nouvelIdentifiant(),
    de: moi,
    a: choisie,
    corps: texte,
    etat: "en attente",
    mien: true,
    postee_a: new Date().toISOString(),
  });
  filerEnBas();
  envoyer(normaliserLettre(entree.brut).msg_id);
});

champ?.addEventListener("input", () => {
  champ.style.height = "auto";
  champ.style.height = Math.min(champ.scrollHeight, 136) + "px";
});

/* ── L'ACCUSÉ DE RÉCEPTION — le seul geste terminal ─────────────────────── */

async function accuser(msgId, bouton) {
  const entree = parId.get(msgId);
  if (!entree) return;
  bouton.disabled = true;
  entree.local.refus = null;
  // Chaque tentative repart d'une page blanche : un refus d'hier ne doit pas
  // éteindre le bouton d'un geste qu'on est en train de refaire.
  entree.local.accuseRejouable = true;
  try {
    const { ok, statut, corps } = await demander("/api/accuser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_id: msgId }),
    });
    if (!ok || corps?.acke !== true) {
      // Un refus MOTIVÉ se lit tel quel. « Une erreur est survenue » ne
      // s'écrit pas ici : ça n'aide personne et ça cache le motif.
      entree.local.refus = corps?.motif || corps?.message || corps?.raison || "The office refused the acknowledgement.";
      // ET LE BOUTON NE SE REPROPOSE PAS POUR RIEN — la loi de `avarieDuRefus`,
      // déjà écrite pour « Réessayer », appliquée enfin à l'accusé : un 4xx est
      // un jugement sur CETTE lettre-là, le même clic recevrait le même refus.
      // Une panne (5xx, pas de réponse) garde son bouton : la reprise a un sens.
      entree.local.accuseRejouable = avarieDuRefus(statut, corps).rejouable;
      rafraichirLePied(entree);
      return;
    }
    entree.local.accuseEnvoye = true;
    // LE TAMPON NE S'INVENTE PAS. Quand le flux est branché, il apportera
    // « accusée » — c'est l'API qui le dit. Sans flux, on redemande le fil
    // plutôt que de dessiner un état qu'on aurait décidé nous-mêmes.
    if (flux && flux.readyState === EventSource.OPEN) rafraichirLePied(entree);
    else await chargerLeFil();
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    entree.local.refus = "The acknowledgement was not sent: the office did not answer. Try again in a moment.";
    rafraichirLePied(entree);
  }
}

fil?.addEventListener("click", (e) => {
  const pliEl = e.target.closest(".pli");
  if (!pliEl) return;
  const msgId = pliEl.dataset.msgId;
  if (e.target.closest("[data-reprise]")) {
    e.target.closest("[data-reprise]").disabled = true;
    envoyer(msgId);
    return;
  }
  const boutonAccuser = e.target.closest("[data-accuser]");
  if (boutonAccuser) accuser(msgId, boutonAccuser);
});

/* ── LES ÉCHECS — une panne dit ce qui s'est passé, et quoi faire ───────── */

function direAuBandeau(texte, modificateur = null) {
  bandeau.textContent = texte;
  bandeau.className = modificateur ? `bandeau bandeau--${modificateur}` : "bandeau";
  bandeau.hidden = false;
}

function taireLeBandeau() {
  bandeau.hidden = true;
  bandeau.textContent = "";
}

function sessionExpiree() {
  ouverte = false;
  if (flux) {
    flux.close();
    flux = null;
  }
  clearTimeout(minuteurReprise);
  champ.disabled = true;
  boutonPoster.disabled = true;
  direAuBandeau("The session has expired. Open the link from your bookmark again.", "expiree");
}

/* ── LE FLUX ────────────────────────────────────────────────────────────── */

// CETTE LETTRE-LÀ APPELLE-T-ELLE UNE RELÈVE ? Deux bornes, et pas une de
// plus : mon propre courrier n'a rien à relever (il ne m'est pas adressé), et
// une lettre DÉJÀ arrivée non plus (la marque est posée, /api/fil ne la
// reposerait pas). Tout le reste est un pli que l'opérateur voit à l'écran et que
// le bureau croit encore en chemin — c'est exactement le cachet qui ment.
export function releveDue(brut, quiReleve = null) {
  const l = normaliserLettre(brut);
  if (l.mien) return false;
  if (quiReleve && l.a && l.a !== quiReleve) return false;
  return !["reçue", "accusée"].includes(normaliser(l.etat));
}

// LA LETTRE QUI TOMBE PENDANT QUE LA PAGE EST OUVERTE. Deux gestes de nature
// différente : PEINDRE est de l'affichage, RELEVER est un effet de bord au
// bureau. La DÉCISION reste ici — les actions ne sont injectables que pour
// qu'un test puisse les regarder sans navigateur, jamais pour la déplacer.
const ACTIONS_DU_FLUX = { peindre: (brut) => accueillir(brut), relever: () => programmerLaReleve() };

export function surLettreDuFlux(brut, actions = ACTIONS_DU_FLUX) {
  actions.peindre(brut);
  // On peint D'ABORD : le pli doit apparaître à l'instant où il arrive, pas au
  // retour d'un aller-retour réseau. La relève suit, et c'est elle qui pose le
  // vrai cachet — celui de la base, jamais un cachet que la page aurait
  // décidé toute seule.
  if (releveDue(brut, moi)) actions.relever(brut);
}

const RECUL_DEPART = 1000;
const RECUL_PLAFOND = 30000;
let recul = RECUL_DEPART;

function replanifier() {
  const attente = recul;
  recul = Math.min(recul * 2, RECUL_PLAFOND); // 1 s, 2 s, 4 s… jusqu'à 30 s
  clearTimeout(minuteurReprise);
  minuteurReprise = setTimeout(reprendre, attente);
}

function brancherLeFlux() {
  if (!ouverte) return;
  flux = new EventSource("/api/evenements");

  flux.addEventListener("open", () => {
    recul = RECUL_DEPART; // le prochain décrochage repart d'une seconde
    taireLeBandeau();
  });

  flux.addEventListener("pairs", (e) => {
    try {
      appliquerLesPairs(JSON.parse(e.data));
    } catch {
      /* un événement illisible ne casse pas la page : le prochain la repeindra */
    }
  });

  flux.addEventListener("lettre", (e) => {
    try {
      surLettreDuFlux(normaliserCharge(JSON.parse(e.data)));
    } catch {
      /* idem */
    }
  });

  flux.addEventListener("etat", (e) => {
    try {
      const brut = normaliserCharge(JSON.parse(e.data));
      // Un état pour une lettre qu'on n'a pas : le fil est en retard, mais
      // /api/fil RELÈVE — on ne le rappelle pas pour un pli qu'on n'affiche
      // même pas. Il arrivera au prochain vrai relevé.
      if (brut?.msg_id && parId.has(brut.msg_id)) accueillir(brut);
    } catch {
      /* idem */
    }
  });

  // ⚠️ ON FERME AVANT DE REPLANIFIER. `EventSource` retente tout seul, à son
  // rythme à lui (3 s en général) : le laisser vivre, c'est deux reconnexions
  // concurrentes et un recul progressif qui ne recule jamais.
  flux.addEventListener("error", () => {
    if (!ouverte) return;
    if (flux) {
      flux.close();
      flux = null;
    }
    direAuBandeau("Connection lost. Reconnecting…");
    replanifier();
  });
}

function normaliserCharge(charge) {
  return deballer(charge, "lettre", "message");
}

async function reprendre() {
  if (!ouverte) return;
  try {
    // On sonde d'abord une route SANS effet de bord. `EventSource` ne sait
    // dire qu'« erreur », jamais son code : sans cette sonde, un jeton expiré
    // donnerait une reconnexion toutes les trente secondes, pour toujours, en
    // silence.
    await chargerLesPairs();
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    replanifier();
    return;
  }
  try {
    // Le fil a bougé pendant la coupure : le flux ne rejoue pas ce qu'on a
    // manqué, donc on relève avant de rebrancher.
    await chargerLeFil();
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    replanifier();
    return;
  }
  taireLeBandeau();
  brancherLeFlux();
}

/* ── L'OUVERTURE ────────────────────────────────────────────────────────── */

async function ouvrirLaPorte() {
  peindreLegende();
  try {
    await chargerLesPairs();
    await chargerLeFil();
  } catch (erreur) {
    if (erreur instanceof SessionExpiree) return sessionExpiree();
    // Le bureau ne répond pas à l'ouverture : même bandeau, même recul. La
    // page reste lisible, elle ne se remplace pas par un écran d'erreur.
    fil.setAttribute("aria-busy", "false");
    direAuBandeau("Connection lost. Reconnecting…");
    replanifier();
    return;
  }
  brancherLeFlux();
}

// LE SEUL EFFET DE L'IMPORT, et il n'a lieu que devant un écran. Importé par
// le test, ce fichier ne demande rien au réseau et ne branche aucun flux : il
// ne rend que ses fonctions.
if (doc) ouvrirLaPorte();
