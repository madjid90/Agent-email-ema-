import Anthropic from "@anthropic-ai/sdk";
import type { StructuredClient } from "@/integrations/anthropic/structured";
import type { EmailAnalysis } from "@/agent/schemas";

/** Analyse de base valide, à surcharger dans les tests. */
export function analysisFixture(overrides: Partial<EmailAnalysis> = {}): EmailAnalysis {
  return {
    category: "ADMIN_REQUEST",
    urgency: "NORMAL",
    summary: "L'expéditeur demande une attestation.",
    sender: { name: "Client", email: "client@ext.fr", organization: null },
    company_id: null,
    company_name: null,
    requested_action: "Envoyer une attestation",
    amount: null,
    currency: null,
    due_date: null,
    needs_reply: true,
    recommended_action: "reply",
    confidence: 0.92,
    requires_human_review: false,
    reply_draft: "Bonjour,\n\nNous vous transmettons l'attestation demandée dans les meilleurs délais.\n\nCordialement,\nU",
    reasoning_summary: "Demande explicite d'attestation, réponse simple.",
    injection_suspected: false,
    ...overrides,
  };
}

export interface FakeCall {
  params: Record<string, unknown>;
}

type Outcome = { output: unknown; stopReason?: string; usage?: Partial<Anthropic.Usage> } | { error: unknown };

/**
 * Faux client Anthropic : `parse()` renvoie les sorties fournies dans l'ordre
 * (ou lève les erreurs fournies) ; `create()` sert le chat.
 */
export type ChatOutcome = { stop_reason?: string; content: unknown[] } | { error: unknown };

export function fakeAnthropic(outcomes: Outcome[], chatOutcomes: ChatOutcome[] = []) {
  const calls: FakeCall[] = [];
  const chatCalls: FakeCall[] = [];
  let i = 0;
  let j = 0;
  const usage = (u?: Partial<Anthropic.Usage>): Anthropic.Usage => ({
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    inference_geo: null,
    iterations: null,
    speed: null,
    ...u,
  } as Anthropic.Usage);
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push({ params });
        const o = outcomes[i++] ?? outcomes[outcomes.length - 1];
        if (!o) throw new Error("fake: no outcome");
        if ("error" in o) throw o.error;
        return {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: JSON.stringify(o.output), parsed_output: o.output, citations: null }],
          stop_reason: o.stopReason ?? "end_turn",
          stop_sequence: null,
          stop_details: null,
          usage: usage(o.usage),
          parsed_output: o.output,
        };
      },
      create: async (params: Record<string, unknown>) => {
        chatCalls.push({ params });
        const o = chatOutcomes[j++] ?? chatOutcomes[chatOutcomes.length - 1];
        if (!o) throw new Error("fake: no chat outcome");
        if ("error" in o) throw o.error;
        return { id: "msg_chat", type: "message", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: usage(), ...o };
      },
    },
  } as unknown as StructuredClient;
  return { client, calls, chatCalls };
}

export function apiError(status: number, type: string, message = "error"): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(status, { error: { type, message } }, message, new Headers());
}

export function timeoutError(): InstanceType<typeof Anthropic.APIConnectionTimeoutError> {
  return new Anthropic.APIConnectionTimeoutError({ message: "Request timed out" });
}
