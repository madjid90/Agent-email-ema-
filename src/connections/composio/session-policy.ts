import { getAgentPolicy } from "../policies";
import type { AgentId, ProviderToolPolicy } from "../types";

const TOOLKITS_BY_AGENT: Record<AgentId, readonly string[]> = {
  ema: ["outlook"],
  archi: ["outlook", "one_drive", "share_point", "googledrive"],
  sales: ["outlook", "hubspot"],
  knowledge: ["outlook", "one_drive", "share_point", "googledrive", "hubspot"],
  custom: [],
};

/**
 * Politique Composio de base.
 *
 * Important :
 * - aucun agent n'obtient de tool destructif ;
 * - Knowledge est strictement read-only ;
 * - un agent custom n'obtient aucun toolkit par défaut ;
 * - l'Action Engine EMA reste responsable des validations humaines avant effet externe.
 *
 * Les allowlists exactes de tools seront ajoutées après le POC réel afin de pinner
 * les slugs réellement utilisés et leur version.
 */
export function buildComposioSessionPolicy(agentId: AgentId): ProviderToolPolicy {
  const policy = getAgentPolicy(agentId);
  const writes = policy.capabilities.some((capability) =>
    capability.endsWith(".send") ||
    capability.endsWith(".write") ||
    capability.endsWith(".move"),
  );

  if (!writes) {
    return {
      toolkits: TOOLKITS_BY_AGENT[agentId],
      tags: {
        enable: ["readOnlyHint"],
        disable: ["destructiveHint"],
      },
      sandboxEnabled: false,
    };
  }

  return {
    toolkits: TOOLKITS_BY_AGENT[agentId],
    tags: {
      enable: ["readOnlyHint", "createHint", "updateHint"],
      disable: ["destructiveHint"],
    },
    sandboxEnabled: false,
  };
}
