# LE FACTEUR — le métier, en une page

*Chantier VALXOS Messenger E.1 — 13/08/2026.*

**Glossaire des sigles.** A8 = livraison au moins une fois ; A9 = accusé nul ⇒
la lettre revient ; Camp B = rien ne s'efface, on déplace ; E.1/E.2 = les deux
chantiers du Facteur : E.1 a construit le démon décrit ici, E.2 est le chantier
suivant, côté destinataire, que les points 3 et 8 plus bas citent comme non
fait (launchd, lui, est livré : voir `INSTALL_ONE_CLICK.md`) ; Run N, Task N,
F/N/M/C/S/G/I-numéros = la revue privée qui a précédé 1.0.0, citée comme
provenance d'une mesure.

Le Facteur est un démon local. Il lit le bureau de poste (`~/.valxos-messenger/broker.db`),
trouve la boîte aux lettres vivante du destinataire, et **remet la lettre au
guichet**. Il doit lire une lettre pour la plier et la livrer — mais il n'en
répète jamais un mot (ni dans le journal, ni dans les événements, voir plus
bas) : il porte le courrier des autres, il ne bavarde pas dessus.

---

## La promesse, et ce qu'elle ne promet pas

> **LIVRAISON AU MOINS UNE FOIS. On préfère un doublon à une lettre perdue.**

Un même courrier peut apparaître deux fois. C'est un **choix**, pas un défaut :
dans cette maison rien ne se perd, et une lettre vue deux fois est un
désagrément — une lettre perdue est une trahison.

Trois mots, trois choses différentes, et il ne faut jamais les confondre :

| Mot | Ce qu'il prouve | Marqueur |
|---|---|---|
| **remis au guichet** | la boîte a accepté les octets | `messages.carried_at` |
| **livré** | un porteur de contexte (hook, ou relève `inbox` CLI/MCP) affirme avoir préparé le contexte | `messages.delivered_at` |
| **accusé** | le destinataire l'a VU et l'a dit lui-même | `messages.acked_at` |

**Le Facteur ne pose JAMAIS `delivered_at`.** Il pose `carried_at`. Et
`carried_at` ne veut pas dire « arrivé » : le portier du destinataire peut jeter
la lettre en silence juste après (limiteur de rafale, gate, mauvaise
incarnation). La seule chose qui rend une lettre terminale est **l'accusé du
destinataire**.

---

## L'invariant qui prime sur tout

> **Accusé nul ⇒ la lettre finit toujours par revenir.**

Il n'existe, nulle part dans ce code, **ni état MORTE, ni quarantaine infinie,
ni suppression**. C'est tenu **par construction**, pas par vigilance :

**L'état d'une lettre ne s'écrit pas, il se dérive.** Il n'y a aucune colonne
« état » : une colonne d'état ment dès qu'un porteur meurt entre son écriture et
son geste. À un instant donné, une lettre est :

| État | Comment il se calcule |
|---|---|
| **ACCUSÉE** | `acked_at` non nul — **le seul état terminal** |
| **RÉSERVÉE** | une tentative active dont le bail court encore |
| **DIFFÉRÉE** | `facteur_not_before_ms > maintenant` |
| **PRÊTE** | tout le reste |

`carried_at`, `delivered_at` et `injected_at` sont des **observations
historiques**. Aucune ne cache jamais une lettre. Et `facteur_not_before_ms` est
une **échéance finie** — même après un échec dit « définitif » (pli trop gros,
enveloppe irrecevable) : on ajourne d'une heure, on l'écrit visiblement, et la
lettre redevient sélectionnable. Un état sans retour tuerait A9 en silence.

---

## Le canal de repli reste branché

Les hooks (`piggyback_fetch`, `startup_sync`) continuent de servir le courrier à
chaque appel d'outil. **Ils ne regardent même pas `facteur_not_before_ms`** :
c'est délibéré. Une lettre que le Facteur a ajournée pour une heure reste servie
par le repli dans la seconde. Le Facteur est le chemin rapide, jamais le seul
chemin.

Le repli respecte deux fenêtres, toutes deux configurables
(`CC2CC_CARRIED_GRACE_MS`, `CC2CC_REDELIVER_AFTER_MS`) : une **grâce** après
`carried_at` (laisser au destinataire le temps d'accuser lui-même) et un
**re-service** après `delivered_at`. Passé ces fenêtres, sans accusé, la lettre
revient.

---

## La tournée, transition par transition

1. **Réserver** (une transaction très courte, **aucun socket dedans**). Les baux
   expirés sont périmés, une lettre PRÊTE est choisie, une **tentative** naît
   avec son bail. Si le bureau est fermé (verrouillé, lecture seule, disque
   plein), on s'arrête ici : **pas de réservation durable, pas de remise** — une
   lettre qu'on ne saurait pas marquer repartirait à chaque tournée, pour
   toujours.
2. **Lier la cible.** On résout le destinataire, on cherche sa boîte, et on écrit
   dans la tentative le **quadruplet** visé : maison, session, heure de
   démarrage, chemin de la boîte. Une lignée **ambiguë** ne se tranche pas : la
   lettre attend (« elle ne se joue pas aux dés »). Une **maison inconnue** n'est
   pas une **boîte endormie** — les deux se journalisent séparément.
3. **Remettre au guichet.** Connexion, jeton, enveloppe NDJSON, délai de
   fermeture, fermeture. **Aucune transaction SQLite n'est ouverte pendant ce
   temps.** L'enveloppe porte toujours `session_id` : c'est le verrou
   d'incarnation. Une lettre adressée à une incarnation périmée est jetée en
   silence par le protocole — ce n'est pas une perte, elle n'est pas accusée,
   donc elle repart.
4. **Marquer.** La clôture exige `attempt_id` + l'état + **la possession du
   bail**. Zéro ligne modifiée ⇒ ce porteur est périmé et n'a plus aucun droit
   sur cette lettre.
5. **Souffler.** Une pause suit **toute tentative de dépôt, quel qu'en soit le
   verdict** (voir « Le rythme » ci-dessous).

---

## Le rythme, et l'arriéré

Trois freins, et ils ne servent pas la même peur.

**Le compte-gouttes suit CHAQUE tentative, pas chaque succès.** Le portier du
destinataire compte des *tentatives* : son limiteur de rafale se heurte à la
connexion, pas au verdict. Et un portier saturé rend précisément des verdicts
d'**échec**. Une pause posée dans la seule branche du succès laisse donc le
chemin de l'échec partir en rafale contre la boîte qui refuse déjà — le défaut se
nourrit lui-même. La pause est **après le dépôt, dans les deux cas**.
Conséquence à connaître : une tournée qui échoue partout dure aussi longtemps
qu'une tournée qui réussit partout (`lettresParTournee × pause`).

**L'ajournement d'une lettre CROÎT.** Chaque tentative infructueuse double
l'attente : 10 min, 20, 40… Sans cela, deux cents lettres non accusées valent
**mille deux cents injections par heure** dans une session vivante — mesuré — et
le compagnon qui les reçoit ne peut plus travailler. A8 promet un doublon, pas
une avalanche. Le doublement s'arrête à `ajournementMaximalMs`, qui est **fini** :
la lettre continue de revenir, plus lentement. Une croissance sans borne serait
une quarantaine déguisée, et A9 l'interdit.

Ce qui compte les tentatives, ce sont les **tentatives closes** de
`facteur_attempts` — jamais un compteur écrit sur la lettre. Un compteur ment dès
qu'un porteur meurt entre son incrément et son geste ; l'état se dérive, ici
aussi.

**Un plafond par boîte et par fenêtre.** Au-delà de `plafondParBoite` remises
vers la même boîte pendant `fenetreDuPlafondMs`, le Facteur **se tait pour elle** :
il ajourne d'un seul geste tout ce qui lui est dû jusqu'à la fin de la fenêtre, et
il journalise **le nombre de lettres en attente** (`facteur_plafond_boite`) au
lieu de les porter une à une. Le silence est **borné par la fenêtre** — il se lève
tout seul, et aucune lettre n'est marquée, accusée ni perdue : elles restent
**dues**. La fin de la fenêtre se calcule sur la plus vieille remise comptée, donc
un démon qui redémarre ne recommence pas à zéro et ne noie pas la chaise qu'il
retrouve.

> Limite connue : le silence groupé s'applique aux lettres portant le **même
> destinataire écrit** que celle qui a touché le plafond. Deux adresses
> différentes qui résolvent vers la même chaise sont ajournées une à une (une
> tentative close chacune, sans dépôt) — borné par `lettresParTournee`, mais ce
> n'est pas gratuit.

### Deux Facteurs

Le verrou de fichier (`~/.valxos-messenger/run/facteur.verrou`) **n'est pas** la garde
contre les doublons : il évite le travail inutile, rien de plus. Ce qui
départage vraiment deux porteurs, c'est **l'index unique partiel** de
`facteur_attempts` (une seule tentative active par lettre) et le **bail**.
Un verrou tenu par un processus mort est repris — sinon un Facteur tué par un
couperet laisserait le courrier sans porteur pour toujours.

**Le verrou naît COMPLET.** Créer le fichier en exclusif *puis* l'écrire laisse,
entre les deux, un verrou qui **existe et qui est vide** — et un concurrent qui
lit un verrou vide conclut « personne », donc **efface le verrou du tenant** pour
poser le sien. La fenêtre n'est pas microscopique : l'appel à `/bin/ps` (~15 ms)
tourne juste avant chez tous les concurrents et les **synchronise pile dessus**.
Mesuré : trois démons lancés ensemble, **deux partis, 6 essais sur 6** (rejoué
ici : 5 essais sur 5 avant le remède). Le prix n'était pas une lettre perdue —
c'était du travail en double, du bruit en base, et un démon qui se croit unique.

Le contenu s'écrit donc dans un **brouillon**, qui prend son nom définitif par un
**lien dur** (`link`) : atomique, et il **refuse d'écraser**. Exclusion mutuelle et
naissance complète dans le même geste. Et, deuxième volet du même remède : **un
verrou vide, tronqué ou illisible n'est JAMAIS lu comme « personne »** —
« absent » et « illisible » sont deux situations, et le doute profite au tenant.

> Conséquence à connaître : un verrou **illisible laissé par une version
> antérieure** (crash entre la création et l'écriture) ne se vole plus tout seul.
> Le code d'aujourd'hui n'en produit plus ; s'il en reste un au sol, il s'efface
> à la main. C'est le prix assumé de « on ne vole pas sur un doute ».

Le verrou inscrit **le numéro de processus ET son heure de naissance**
(`proc_start`), exactement comme les fiches de boîtes aux lettres. Un numéro se
recycle : sans l'heure, le premier inconnu qui hérite du numéro passe pour le
Facteur d'hier, et le courrier s'arrête **pour toujours** — sous launchd, en
boucle de respawn silencieuse. Avec l'heure, un tenant qui n'est plus le bon se
reprend. Le doute profite toujours au tenant : verrou d'avant ce remède (sans
heure) ou heure illisible ⇒ on ne vole pas.

### Le mode UNE-LETTRE (`--seulement-la-lettre`)

`node src/bin/facteur.js --une-tournee --seulement-la-lettre L42` fait une tournée
qui **ne prend QUE cette lettre-là**, quoi qu'il y ait d'autre au bureau. C'est la
**porte de la cérémonie** : un Facteur non filtré lancé à côté de vraies boîtes
porterait du courrier réel que personne n'a prévu.

La lettre nommée est portée **normalement** — réservation, bail, quadruplet visé,
compte-gouttes, marquage : le filtre restreint la sélection, il ne court-circuite
aucune garde.

> **Un identifiant qui ne correspond à rien ne porte RIEN.** Jamais de repli
> silencieux sur « alors je prends tout » — ce serait le pire défaut possible de
> ce mode. Le filtre **restreint** la requête de réservation ; il ne l'élargit
> jamais. Et il le **dit** : motif `lettre-introuvable` (aucune lettre de ce nom)
> ou `lettre-non-prise` avec l'état dérivé (ACCUSÉE, RÉSERVÉE, DIFFÉRÉE) dans le
> bilan, événement `facteur_lettre_non_prise` au journal, et **code de sortie 4**
> — un identifiant mal recopié ne doit pas ressembler à une tournée tranquille.

`--seulement-la-lettre` **sans identifiant** (oublié, ou avalé par le drapeau
suivant : `--seulement-la-lettre --une-tournee`) **refuse de démarrer** (code 2,
motif au journal). Sans ce refus, l'oubli de la valeur porterait tout le courrier.

> Limite connue : le filtre borne ce que la tournée **prend**. Si la boîte visée a
> déjà touché son plafond de politesse, le silence groupé (`taireLaBoite`) ajourne
> encore toutes les lettres **du même destinataire écrit** — il n'écrit aucune
> marque et ne perd rien, mais il touche des lignes qu'on n'avait pas nommées.
> À la cérémonie, le bureau est éphémère : le cas ne peut pas se présenter.

### La famine

Une tournée balaie le courrier entre un **curseur** et une **frontière figée**.
Le curseur ne recule pas : une lettre bloquée passe **derrière** lui au lieu de
remplir toutes les tournées. Avec `B` lettres bloquées et `N` lettres par
tournée, une lettre saine est atteinte en **ceil((B+1)/N)** tournées. Quand la
fenêtre est épuisée, un nouveau balayage s'ouvre sur le courrier du moment.

---

## Les seuils, et où les changer

Aucun n'est codé en dur : ils vivent dans `src/lib/config.js`
(`REGLAGES_FACTEUR_PAR_DEFAUT`), chacun pilotable par l'environnement.
Les noms `VALXOS_*` sont les réglages recommandés. Les noms `CC2CC_*` entre
parenthèses restent des alias de compatibilité ; si les deux sont posés, le
réglage `VALXOS_*` prend priorité.

| Réglage | Défaut | Variable |
|---|---|---|
| bail d'une tentative | 15 000 ms | `VALXOS_FACTEUR_BAIL_MS` (`CC2CC_FACTEUR_BAIL_MS`) |
| ajournement après une remise | 600 000 ms | `VALXOS_FACTEUR_AJOURNEMENT_REMISE_MS` (`CC2CC_FACTEUR_AJOURNEMENT_REMISE_MS`) |
| ajournement après un échec passager | 5 000 ms | `VALXOS_FACTEUR_AJOURNEMENT_TRANSITOIRE_MS` (`CC2CC_FACTEUR_AJOURNEMENT_TRANSITOIRE_MS`) |
| ajournement d'un courrier inacheminable | 30 000 ms | `VALXOS_FACTEUR_AJOURNEMENT_INACHEMINABLE_MS` (`CC2CC_FACTEUR_AJOURNEMENT_INACHEMINABLE_MS`) |
| ajournement après un échec définitif | 3 600 000 ms | `VALXOS_FACTEUR_AJOURNEMENT_DEFINITIF_MS` (`CC2CC_FACTEUR_AJOURNEMENT_DEFINITIF_MS`) |
| plafond de croissance d'un ajournement | 14 400 000 ms | `VALXOS_FACTEUR_AJOURNEMENT_MAX_MS` (`CC2CC_FACTEUR_AJOURNEMENT_MAX_MS`) |
| remises par boîte et par fenêtre | 12 | `VALXOS_FACTEUR_PLAFOND_PAR_BOITE` (`CC2CC_FACTEUR_PLAFOND_PAR_BOITE`) |
| fenêtre de ce plafond | 600 000 ms | `VALXOS_FACTEUR_FENETRE_PLAFOND_MS` (`CC2CC_FACTEUR_FENETRE_PLAFOND_MS`) |
| lettres prises par tournée | 50 | `VALXOS_FACTEUR_LETTRES_PAR_TOURNEE` (`CC2CC_FACTEUR_LETTRES_PAR_TOURNEE`) |
| pause après CHAQUE tentative de dépôt | 2 000 ms | `VALXOS_FACTEUR_PAUSE_MS` (`CC2CC_FACTEUR_PAUSE_MS`) |
| délai maximal d'un dépôt | 5 000 ms | `VALXOS_FACTEUR_DELAI_REMISE_MS` (`CC2CC_FACTEUR_DELAI_REMISE_MS`) |
| délai de fermeture | 150 ms | `VALXOS_FACTEUR_DELAI_FERMETURE_MS` (`CC2CC_FACTEUR_DELAI_FERMETURE_MS`) |
| sommeil entre deux tournées | 1 000 ms | `VALXOS_FACTEUR_TOURNEE_CHAQUE_MS` (`CC2CC_FACTEUR_TOURNEE_CHAQUE_MS`) |
| battement de vie du démon | 60 000 ms | `VALXOS_FACTEUR_BATTEMENT_CHAQUE_MS` (`CC2CC_FACTEUR_BATTEMENT_CHAQUE_MS`) |
| inventaire des maisons | `~/.claude`, plus `$CLAUDE_CONFIG_DIR` s'il désigne une autre maison | `VALXOS_MAISONS` (`CC2CC_MAISONS`, séparées par `:`), qui remplace le défaut |

**Des règles sont vérifiées au démarrage et refusées si elles sont fausses :**

- `bail > délai de dépôt + délai de fermeture + 5 000 ms`. Sans elle, un dépôt
  lent rendrait la tentative reprenable **pendant** que son porteur écrit sur le
  fil.
- `ajournementMaximalMs` ≥ chacun des quatre ajournements. Un « maximum » plus
  court **raccourcirait** l'attente qu'il prétend borner.
- `plafondParBoite ≥ 1`. Un plafond à zéro rendrait une boîte muette pour
  toujours : un silence sans retour, donc A9 mort.
- `battementChaqueMs` fini et strictement positif. Un battement nul serait le
  journal bavard qu'on vient d'éteindre ; un battement infini, un démon muet.

Le schéma du bureau porte le numéro **6** (`user_version`) : les tables du
Facteur sont une addition de schéma, et un bureau qui les porte ne doit pas être
indiscernable d'un bureau qui ne les a jamais vues.

L'inventaire des maisons est **relu à chaque tournée** : une maison créée après
le démarrage du démon est vue au tour suivant.

---

## Ce que le journal contient

Une ligne NDJSON par événement, sur la sortie d'erreur :
`msg_id`, `attempt_id`, motif, maison, session visée, échéance de reprise.

**Le silence ne s'écrit pas (19/08).** Une tournée où rien n'a bougé (aucune
prise, remise, ajournement, aucun motif) ne laisse pas de ligne `facteur_tournee`
en mode démon. À la place, un `facteur_battement` périodique (réglage
`battementChaqueMs`, défaut 60 s) prouve que le démon vit et dit combien de
tournées sont restées muettes ; le dernier segment part AVANT
`facteur_hors_service` à l'arrêt. La fenêtre pendant laquelle un démon figé peut
passer inaperçu vaut donc un battement PLUS la durée d'une tournée — le battement
se teste entre deux tournées, jamais pendant — c'est le prix, choisi, du journal
discret. Le mode `--une-tournee` n'a pas de battement : sa tournée se dit
TOUJOURS, même muette — le one-shot au journal vide ressemblerait à un job
cassé.

**Jamais le corps d'une lettre. Jamais son objet. Jamais le jeton d'une boîte.**
Ni dans le journal, ni dans `delivery_events`, ni dans `facteur_attempts`. On
porte le courrier des autres ; on n'en répète rien.

---

## Le faire tourner, et l'arrêter

```bash
node src/bin/facteur.js --une-tournee            # une seule tournée, bilan JSON
node src/bin/facteur.js --tours 3                # trois tournées, puis rendre la main
node src/bin/facteur.js                          # le démon
node src/bin/facteur.js --maisons ~/.claude:~/.claude-work
node src/bin/facteur.js --une-tournee --seulement-la-lettre L42   # CELLE-CI, rien d'autre
```

Codes de sortie : **0** la tournée a eu lieu · **2** la ligne de commande est
refusée (on n'a pas démarré) · **3** un autre Facteur tenait le verrou · **4** le
mode une-lettre n'a rien pris.

Sous launchd (voir `INSTALL_ONE_CLICK.md`) : `launchctl bootout gui/$UID/<label>`
l'arrête. `SIGTERM` et `SIGINT` sont propres : la tournée en cours se termine et
le verrou se relâche. Une tentative interrompue n'est pas une lettre perdue —
son bail expire et la lettre repart.

---

## Ce que ce dessin ne résout PAS (à lire avant de lui faire confiance)

1. **Le bail ne ferme pas un socket.** Un Facteur suspendu peut se réveiller
   après l'expiration de son bail et écrire en même temps que son successeur. Son
   `attempt_id` périmé ne peut plus rien écrire dans la base, mais le doublon de
   transport, lui, reste possible. Assumé (A8).
2. **`carried_at` reste un faux positif applicatif.** Il prouve au mieux « les
   octets sont partis et la porte s'est refermée ». Une authentification refusée,
   un gate, une file pleine peuvent encore jeter la lettre en silence.
3. **L'accusé reste postérieur à la visibilité.** Le modèle voit la lettre avant
   de pouvoir accuser ; un crash entre les deux produit un doublon. Le vrai
   composant destinataire (registre durable écrit AVANT exposition) est le
   chantier **E.2**, pas celui-ci.
4. **La succession n'est pas tranchée.** Une lettre remise à la session A, puis
   l'opérateur désigne B avant l'accusé : elle repart vers B. A peut encore accuser
   tardivement. Le produit doit décider si cet accusé ancien reste recevable.
5. **Le courrier empoisonné revient éternellement.** C'est conforme à A9, mais
   ça fait grossir `delivery_events`. Il faut une **file visible d'intervention**,
   jamais une quarantaine invisible.
6. **L'horloge murale gouverne le bail.** Un saut d'horloge vers l'avant permet
   une reprise prématurée ; vers l'arrière, il la retarde.
7. **`synchronous=NORMAL`.** Pour un crash de processus, la transaction SQLite
   suffit — c'est éprouvé, avec de vrais processus tués. Pour une coupure de
   courant ou une corruption de volume, « toujours » exigerait `synchronous=FULL`,
   une sauvegarde prouvée et une restauration testée.
8. **L'adresse de retour ne reçoit rien.** Le pli porte un reçu
   (`Receipt: {attempt_id}`) et l'enveloppe une adresse de retour (`fromSession`,
   la session de l'expéditeur, `sessionDeLExpediteur` en round.js), mais en E.1
   **rien ne les lit** : l'outil `ack` ne vérifie ni l'un ni l'autre. Ce qu'il
   vérifie, et a TOUJOURS vérifié — `ackMessage` → `droitDAccuser(destinataire,
   signataire)`, sur CHAQUE accusé, ça prédate G1 — c'est que l'agent appelant
   a le droit de signer POUR le destinataire réel de la lettre. G1 a ajouté une
   garde SÉPARÉE, au-dessus : si un `self` est DÉCLARÉ (paramètre legacy), il
   est vérifié CONTRE l'identité dérivée de la session (`verifierIdentiteDeclaree`,
   server.js) — la dérivée elle-même reste le repère, jamais la partie
   vérifiée. Rien de tout ça ne lit le reçu ou l'adresse de retour du pli : les
   deux attendent encore E.2 ; ne les lisez pas comme des fonctions
   d'aujourd'hui.
9. **L'arrêt n'est vu qu'ENTRE deux tournées.** `SIGTERM` interrompt la boucle du
   démon, pas la tournée en cours — et une tournée peut durer
   `lettresParTournee × pause` (100 s aux défauts). Sous un couperet plus court
   (launchd tue 20 s après son `SIGTERM`), le `finally` ne s'exécute pas et le
   verrou reste au sol. Ce n'est plus fatal — l'heure de naissance inscrite au
   verrou le rend reprenable au démarrage suivant — mais le courrier attend un
   tour. Passer le signal **dans** la tournée reste à faire.

---

## Trois avertissements au prochain (dettes de banc, écrites pour qu'on les voie)

**Des deux remèdes du verrou, un seul est mordu par une mutation.** Remettre
« créer puis écrire » **seul** ne fait rougir aucun test : le second remède (un
verrou illisible n'est jamais « personne ») suffit à fermer la course, et il
l'absorbe. Mesuré : mutation de la naissance seule → 3 essais sur 3 au vert ;
mutation du lecteur seule → les deux tests du verrou rougissent ; **les deux
ensemble → la course rougit 3 essais sur 3** (2 ou 3 partis), comme avant le
remède (5 sur 5). La naissance complète est donc de la **défense en profondeur** :
elle protège les lecteurs qui ne sont pas nous (`valxos-doctor`, le moniteur, un
`cat` humain), qui n'ont pas ce second remède. Ne la retirez pas en croyant que
le banc vous arrêtera — il ne le fera pas.

**La transaction de réservation n'est mordue par aucune mutation.** `prendreUneLettre`
tient tout dans une transaction `immediate()` — périmer les baux, choisir,
insérer la tentative, avancer le curseur. C'est de la **défense en profondeur** :
aujourd'hui, l'index unique partiel suffit à départager deux porteurs, donc
casser la transaction ne fait rougir aucun test. Un réordonnancement (une lecture
sortie de la transaction, un `INSERT` déplacé) la rendrait **porteuse** sans
qu'aucun banc ne s'en aperçoive. Si vous touchez à cette fonction, écrivez
d'abord le test qui la rend load-bearing.

**`getPendingForCarrier` (`src/lib/database.js`) portait un commentaire qui
affirmait la règle interdite** — « ce que le Facteur a le droit de prendre : ni
remis, ni livré, ni accusé » — au-dessus d'un `WHERE carried_at IS NULL AND
delivered_at IS NULL`. **Le Facteur ne l'utilise pas** et ne doit jamais
l'utiliser : `carried_at` n'est pas un état terminal, et sélectionner sur lui
rendrait une lettre remise mais jamais accusée **invisible** — A9 mort. Le
commentaire est CORRIGÉ (remède de la revue adverse #2, S7) : aucun appelant en
production ne l'exerce aujourd'hui — ni le Facteur, ni le canal de repli, qui
est vraiment servi par `getPendingForContext` juste au-dessus dans le même
fichier. La fonction elle-même survit par Camp B (rien ne s'efface), inerte,
jamais branchée sur un chemin de livraison.
