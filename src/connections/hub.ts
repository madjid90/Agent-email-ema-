import { buildExternalConnectionUserId } from "./identity";
import { buildComposioSessionPolicy } from "./composio/session-policy";
import type { ConnectionContext, ConnectionHub, ConnectionSessionDescriptor } from "./types";

/**
 * Première implémentation du Connection Hub.
 *
 * Cette couche est volontairement indépendante du SDK Composio. Elle fige notre
 * contrat interne avant de brancher le fournisseur réel : EMA/ARCHI/SALES ne
 * dépendront jamais directement de Composio.
 */
export class AgencyConnectionHub implements ConnectionHub {
  async createSession(context: ConnectionContext): Promise<ConnectionSessionDescriptor> {
    return {
      provider: "composio",
      externalUserId: buildExternalConnectionUserId(context.organizationId, context.userId),
      context,
      policy: buildComposioSessionPolicy(context.agentId),
    };
  }
}
