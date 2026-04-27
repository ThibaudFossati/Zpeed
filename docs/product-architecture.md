# Architecture produit — identité & réputation musicale

## Principe

La réputation musicale doit être **durable** et **scalable**. Le client (dont `localStorage`) peut aider à **reconnaître** un utilisateur sur un même appareil, mais **n’en est pas la source de vérité** à terme.

## Court terme (MVP / POC)

- `localStorage` : acceptable pour persister `userId`, `displayName` et réutiliser la même identité sur le device.
- Continuer à remonter côté serveur : `userId`, `displayName`, stats de session (likes / skips sur titres, propositions, stats contributeur par room), etc.
- Les agrégats persistés dans la session (ex. `sessions.json`, champs de session) restent des **vues par room / par device** tant qu’il n’y a pas de profil global serveur.

## Cible — profil utilisateur serveur

Un **profil utilisateur** centralisé (par compte), distinct de la session room :

| Champ (exemple)     | Rôle |
|---------------------|------|
| `userId`            | Identifiant stable côté serveur |
| `displayName`       | Nom affiché |
| `authProvider`      | Origine du compte |
| `googleId` / `appleId` / `spotifyId` / `emailHash` | Liens d’auth (selon stratégie retenue) |
| `musicIdentity`     | Préférences / goût agrégé (hors scope auth) |
| `contributorStats`  | Adds, likes donnés, etc. (cross-sessions) |
| `reputation`        | Score / niveaux (à définir plus tard) |
| `createdAt` / `lastSeenAt` | Cycle de vie du compte |

**Spotify** : uniquement comme **source musicale** (lecture, métadonnées, file), **pas** comme identité principale du compte utilisateur.

## Priorité auth (future — non implémentée dans le POC)

1. Google login  
2. Apple login  
3. Magic link email  
4. Spotify : musique seulement, pas identité primaire  

*Aucune implémentation d’auth dans ce document : orientation uniquement.*

## Références code actuelles (MVP Magic Invite / swipe)

- Stats contributeur par session : `server.js` (`contributorStats`, `bumpContributor`, `computeMagicInviteSuggestions`).
- Métadonnées room : `lib/spotifyPipeline.js` → `metaForRoom` → `magicInviteSuggestions`.
- UI host : `public/host.html` → `renderMagicInviteHost`.
