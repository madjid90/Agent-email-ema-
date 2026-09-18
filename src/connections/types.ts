export const AGENT_IDS = ["ema", "archi", "sales", "knowledge", "custom"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const CAPABILITIES = [
  "email.read",
  "email.search",
  "email.attachment.read",
  "email.send",
  "email.move",
  "calendar.read",
  "calendar.write",
  "file.read",
  "file.write",
  "file.move",
  "crm.read",
  "crm.write",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface ConnectionContext {
  organizationId: string;
  userId: string;
  agentId: AgentId;
}

export interface AgentPolicy {
  agentId: AgentId;
  capabilities: readonly Capability[];
  requiresHumanApproval: readonly Capability[];
}

export interface ProviderToolPolicy {
  toolkits: readonly string[];
  tags: {
    enable?: readonly ("readOnlyHint" | "createHint" | "updateHint" | "destructiveHint")[];
    disable?: readonly ("readOnlyHint" | "createHint" | "updateHint" | "destructiveHint")[];
  };
  sandboxEnabled: boolean;
}

export interface ConnectionSessionDescriptor {
  provider: "composio" | "native";
  externalUserId: string;
  context: ConnectionContext;
  policy: ProviderToolPolicy;
}

export interface ConnectionHub {
  createSession(context: ConnectionContext): Promise<ConnectionSessionDescriptor>;
}
