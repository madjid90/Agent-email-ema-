import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openIsolatedDb, type Db } from "@/database/connection";
import * as emails from "@/database/repositories/emails";
import * as analyses from "@/database/repositories/analyses";
import { listChatMessages } from "@/database/repositories/chat";
import { runChatTurn, CHAT_READONLY_TOOLS } from "@/agent/chat";
import { registerAllTools, resetToolsForTests } from "@/tools";
import { settingsSchema } from "@/lib/config";
import { fakeAnthropic, analysisFixture } from "./helpers/fake-anthropic";

const settings = settingsSchema.parse({ company: { name: "X", userName: "U", email: "u@x.fr" } });

describe("Chat EMA (lecture seule)", () => {
  let db: Db;
  beforeEach(() => {
    db = openIsolatedDb();
    resetToolsForTests();
    registerAllTools();
  });
  afterEach(() => resetToolsForTests());

  it("n'expose que des outils de lecture (+ préparation de signature, qui ne fait que proposer une action CRITICAL)", () => {
    for (const forbidden of ["reply_email", "forward_email", "send_email", "prepare_payment_request", "schedule_followup", "cancel_followup", "archive_document", "apply_signature", "apply_stamp"]) {
      expect(CHAT_READONLY_TOOLS).not.toContain(forbidden);
    }
    expect(CHAT_READONLY_TOOLS).toContain("prepare_signed_document");
  });

  it("explique une analyse existante via get_email_analysis puis répond", async () => {
    const e = emails.insertEmail({ graphId: "g", subject: "Devis", senderEmail: "c@ext.fr", receivedAt: "2026-09-15T10:00:00.000Z" }, db);
    analyses.insertAnalysis(e.id, analysisFixture({ category: "QUOTE", summary: "Devis de 3 840 € à signer." }), { model: "claude-opus-5" }, db);
    const { client, chatCalls } = fakeAnthropic([], [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "get_email_analysis", input: { email_id: e.id } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "EMA a classé cet email comme devis : 3 840 € à signer.", citations: null }] },
    ]);
    const r = await runChatTurn("Explique-moi l'analyse du devis", { db, settings, client });
    expect(r.reply).toContain("devis");
    expect(r.toolCalls).toEqual([{ name: "get_email_analysis", ok: true }]);
    const toolNames = ((chatCalls[0]?.params as { tools: { name: string }[] }).tools).map((t) => t.name);
    expect(toolNames).not.toContain("reply_email");
    expect(toolNames).toContain("get_email_analysis");
    const second = (chatCalls[1]?.params as { messages: { role: string; content: unknown }[] }).messages;
    expect(second[second.length - 1]?.role).toBe("user");
    expect(JSON.stringify(second[second.length - 1]?.content)).toContain("Devis de 3 840");
    expect(listChatMessages(10, db).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("un outil inconnu ou interdit renvoie une erreur au modèle sans casser le tour", async () => {
    const { client } = fakeAnthropic([], [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "reply_email", input: { email_id: "x", body: "y" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Je ne peux pas envoyer d'email depuis le chat.", citations: null }] },
    ]);
    const r = await runChatTurn("Réponds à X", { db, settings, client });
    expect(r.toolCalls).toEqual([{ name: "reply_email", ok: false }]);
    expect(r.reply).toContain("Je ne peux pas");
  });
});
