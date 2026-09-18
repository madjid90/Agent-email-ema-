# Plateforme agence — architecture cible

Cette branche transforme EMA en premier module d'une plateforme d'agents réutilisable.

## Principes

1. **Une connexion utilisateur, plusieurs agents.** Un compte Microsoft/Google/CRM n'est connecté qu'une fois.
2. **Isolation organisation + utilisateur.** Toute session externe est liée à un identifiant opaque dérivé de `organizationId + userId`.
3. **Fail closed.** Un agent sur mesure ne reçoit aucun droit par défaut.
4. **Aucun tool destructif.** Les sessions Composio désactivent `destructiveHint`.
5. **Knowledge est read-only.** Le RAG ne peut jamais exécuter d'action externe.
6. **Action Engine conservé.** Les actions externes sensibles restent soumises aux validations EMA, même si Composio expose techniquement le tool.
7. **Abstraction fournisseur.** EMA/ARCHI/SALES appellent le Connection Core, jamais Composio directement.

## Modules standards

- **EMA** — email, recherche, réponses, relances, calendrier en lecture.
- **ARCHI** — email + pièces jointes + classement documentaire.
- **SALES** — email commercial + calendrier + CRM.
- **Knowledge** — RAG emails/documents/CRM en lecture seule.
- **Custom** — aucun droit tant qu'une politique explicite n'a pas été définie.

## Architecture

```
Control plane agence
        |
        v
Client runtime
  |
  +-- Connection Core --> Composio (V1) / Native connectors (fallback)
  +-- Policy Core     --> capabilities + validations
  +-- Agent Core      --> EMA / ARCHI / SALES / custom
  +-- Knowledge Core  --> PostgreSQL + pgvector (phase suivante)
  +-- Action Engine   --> validations + idempotence + historique
```

## Connexions Composio

La V1 utilisera les sessions Composio avec un `user_id` opaque. Les toolkits seront restreints par agent et les tools destructifs désactivés. Le SDK ne doit pas être importé dans les agents eux-mêmes.

La première intégration réelle à valider est Outlook :
1. connecter un vrai compte ;
2. lire/rechercher des emails ;
3. récupérer une pièce jointe ;
4. préparer puis envoyer une action via l'Action Engine ;
5. vérifier reconnexion/expiration ;
6. valider un trigger de nouvel email.

## Migration progressive

EMA continue de fonctionner avec Microsoft Graph natif pendant la migration. Le Connection Core est ajouté en parallèle, puis les appels sont basculés fonctionnalité par fonctionnalité. Aucun big-bang.

## Étapes suivantes

1. Brancher le SDK Composio après montée de Node vers 22.22.3+.
2. Ajouter `COMPOSIO_API_KEY` et le POC Outlook réel.
3. Pinner les versions/tool slugs réellement utilisés après le POC.
4. Introduire PostgreSQL + pgvector pour le Knowledge Core.
5. Construire ARCHI sur le Core.
6. Construire SALES sur le Core.
7. Ajouter audit/onboarding/provisioning agence.
