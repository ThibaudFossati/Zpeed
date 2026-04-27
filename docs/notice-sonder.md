# Notice explicative - SONDER

## 1) C'est quoi SONDER ?

SONDER est une application musicale collaborative qui permet a un host et ses invites de construire une ambiance en direct.
Chaque participant peut proposer des morceaux, voter, et faire monter les titres dans la file.

## 2) A quoi ca sert ?

- Animer une soiree, un afterwork ou un evenement prive
- Laisser les invites participer a la musique sans perdre le controle host
- Eviter les frictions techniques avec une interface simple

## 3) Comment ca marche (vue rapide)

1. Le host ouvre SONDER et cree une session
2. Les invites rejoignent via QR code ou lien
3. Chacun propose des titres
4. Les votes valident les morceaux
5. Le host garde la maitrise de la lecture

## 4) Roles dans l'application

### Host

- Cree la session
- Connecte Spotify
- Active le son
- Gere la lecture
- Peut valider/ajuster la file

### Invites

- Rejoignent avec un code
- Proposent des morceaux
- Votent pour faire monter les titres
- Interagissent en temps reel

## 5) Fonctionnalites principales

- Creation instantanee de session
- Rejoindre par QR code
- Recherche de titres
- File d'attente collaborative
- Systeme de votes avec seuil de validation
- Statuts clairs: en attente, valide, en lecture
- Interface host mobile-first

## 6) Signification des statuts dans la file

- **Vote : X / Y** ou **👍 X / Y votes** : le morceau progresse vers le seuil
- **Valide · pret a jouer** : le seuil est atteint
- **En lecture** : morceau actuellement joue

## 7) Experience demo

SONDER est optimise pour les demos rapides:

- Un bouton clair "Activer le son"
- Messages simples pour guider l'utilisateur
- Synchronisation de l'etat player via serveur
- Degradation douce si Spotify limite temporairement les requetes

## 8) Bonnes pratiques d'usage

- Le host lance Spotify avant le debut de session
- Les invites votent pour prioriser les titres
- Garder une file variee pour maintenir le rythme
- Utiliser le mode demo pour presenter l'app meme sans lecture immediate

## 9) FAQ courte

### Les invites peuvent-ils casser la lecture ?
Non. Le host conserve le controle principal de la lecture.

### Pourquoi certains morceaux ne partent pas tout de suite ?
Ils doivent atteindre le seuil de votes defini pour la session.

### Que faire si Spotify ralentit ?
SONDER continue de fonctionner et affiche un message d'information temporaire.

## 10) Resume

SONDER transforme la musique en experience collective:
simple a lancer, fun a utiliser, et structuree pour garder un flux musical coherent pendant tout l'evenement.

