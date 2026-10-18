# Doctrine du Facteur — il livre, il ne juge pas

*Doctrine de conception, 27/09/2026. Le métier en détail : [`FACTEUR.md`](FACTEUR.md).*

> **Le courrier des autres ne se lit pas, même quand on le porte.**

## Ce que fait le Facteur

- Il **livre** : il trouve la boîte vivante du destinataire et remet la lettre au guichet.
- Il **réveille** : la lettre entre dans la session vivante sans qu'un humain la porte.
- C'est tout. Il plie la lettre pour la porter, et n'en répète jamais un mot.

## Ce qu'il ne fait jamais

- Il ne **lit** pas une lettre pour en juger le contenu.
- Il ne **filtre** pas, ne **note** pas, ne **classe** pas.
- Il ne **jette** jamais une lettre : sans accusé du destinataire, elle revient toujours.
- La **priorité** est une métadonnée pour le lecteur, jamais un filtre pour le porteur.
  Le Facteur remet toutes les lettres de la même façon ; c'est le lecteur qui décide
  quoi regarder en premier.

## Qui d'autre a le droit de regarder, et d'agir

- **`valxos-doctor`** lit l'état pour le diagnostiquer et le rapporte. Il ne touche à aucune lettre.
  Il n'écrit rien sans `--reap` : il constate les chaises mortes et nomme le remède.
  Les deux gestes explicites qui marquent des chaises mortes sont `valxos-doctor --reap`
  et `valxos-chaise moissonner` ; ni l'un ni l'autre n'efface rien.
- **`valxos-chaise`** est le geste humain explicite : désigner, libérer, réexpédier
  ou moissonner une chaise. Aucune machine ne tranche à la place d'un humain à qui va le courrier.

Si un jour un porteur commence à juger ce qu'il porte, ce n'est plus un Facteur.
