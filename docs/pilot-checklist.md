# Checklist pilote 30 jours

À dérouler avant de confier EMA à un dirigeant, puis à suivre pendant le pilote. Objectif : aucune surprise en production, un coût mesuré, une réversibilité complète.

## Avant le lancement (bloquant)

| Vérification | Comment | OK si |
|---|---|---|
| Installation saine | `npm run doctor` | aucun FAIL |
| Tests automatisés | `npm run check` | vert |
| Email de bout en bout | envoyer un vrai email à la boîte, valider la réponse sur WhatsApp | réponse reçue par le destinataire, dans le thread |
| WhatsApp conversationnel | « Qu'est-ce que j'ai d'important aujourd'hui ? » puis un brouillon validé | réponse et envoi réels |
| Facture | email avec facture PDF de test | transfert proposé vers le bon destinataire, validé, reçu |
| Devis et signature | devis PDF de test, **signature et tampon de test** | PDF signé correct, retourné dans le thread |
| Relance | relance courte programmée, cas « réponse reçue » et cas « sans réponse » | annulation automatique / brouillon validé |
| Sauvegarde | `./scripts/backup.sh` | archive créée, `backup.json` présent |
| Restauration | restaurer sur une instance jetable | compteurs identiques, intégrité `ok` |
| Santé | `curl https://.../api/health` et Paramètres → Diagnostic | `ok`, aucun contrôle FAIL |
| Sécurité | `/setup` sans session, mauvais mot de passe ×9, en-têtes HTTPS | 307, blocage au 9e essai, en-têtes présents |
| Redémarrage | `pm2 restart all` pendant une validation en attente | action toujours en attente, aucun double envoi |

## Pendant le pilote

- **J+1** : vérifier `pm2 status`, `/api/health`, la première sauvegarde et le premier email traité.
- **Chaque semaine** : Paramètres → Diagnostic (coût Claude, espace disque), `npm run doctor`, revue des actions refusées et des relances sans réponse.
- **Coût** : relever `Consommation Claude` chaque lundi (appels, tokens, estimation) pour projeter le coût mensuel par client.
- **Incidents** : noter dans `docs/e2e-report.md` tout comportement inattendu, avec la date et l'action concernée.

## Critères de réussite à 30 jours

1. Aucune action exécutée sans validation humaine.
2. Aucun email envoyé en double.
3. Aucune donnée client sortie du VPS (hors Microsoft, Anthropic et Meta, voir `docs/privacy.md`).
4. Le dirigeant traite ses validations depuis WhatsApp sans ouvrir l'interface.
5. Coût Claude mensuel connu et stable.
6. Sauvegarde quotidienne présente et restauration testée au moins une fois.

## Arrêt du pilote

Export des données puis suppression de l'instance : `docs/privacy.md`.
