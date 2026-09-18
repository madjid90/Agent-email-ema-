import type { AgentId, AgentPolicy, Capability } from "./types";

const POLICIES: Record<AgentId, AgentPolicy> = {
  ema: {
    agentId: "ema",
    capabilities: [
      "email.read",
      "email.search",
      "email.attachment.read",
      "email.send",
      "calendar.read",
    ],
    requiresHumanApproval: ["email.send"],
  },
  archi: {
    agentId: "archi",
    capabilities: [
      "email.read",
      "email.search",
      "email.attachment.read",
      "email.move",
      "file.read",
      "file.write",
      "file.move",
    ],
    requiresHumanApproval: [],
  },
  sales: {
    agentId: "sales",
    capabilities: [
      "email.read",
      "email.search",
      "email.send",
      "calendar.read",
      "calendar.write",
      "crm.read",
      "crm.write",
    ],
    requiresHumanApproval: ["email.send", "calendar.write", "crm.write"],
  },
  knowledge: {
    agentId: "knowledge",
    capabilities: [
      "email.read",
      "email.search",
      "email.attachment.read",
      "file.read",
      "crm.read",
    ],
    requiresHumanApproval: [],
  },
  custom: {
    // Un agent sur mesure démarre sans droit. Les capacités sont ajoutées
    // explicitement lors de sa configuration : fail closed par défaut.
    agentId: "custom",
    capabilities: [],
    requiresHumanApproval: [],
  },
};

export function getAgentPolicy(agentId: AgentId): AgentPolicy {
  return POLICIES[agentId];
}

export function canAgentUse(agentId: AgentId, capability: Capability): boolean {
  return getAgentPolicy(agentId).capabilities.includes(capability);
}

export function requiresHumanApproval(agentId: AgentId, capability: Capability): boolean {
  return getAgentPolicy(agentId).requiresHumanApproval.includes(capability);
}

export function assertAgentCapability(agentId: AgentId, capability: Capability): void {
  if (!canAgentUse(agentId, capability)) {
    throw new Error(`Capacité interdite pour ${agentId}: ${capability}`);
  }
}
