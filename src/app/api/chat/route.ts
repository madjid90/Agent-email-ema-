import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { listChatMessages, clearChat } from "@/database/repositories/chat";
import { getConfiguredIntegrations } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { runChatTurn } from "@/agent/chat";

export const GET = route(async () => ok(listChatMessages(100)));

export const POST = route(async (req) => {
  const { message } = await parseBody(req, z.object({ message: z.string().min(1).max(4000) }));
  if (!getConfiguredIntegrations().anthropic) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY non renseignée : le chat est indisponible");
  await runChatTurn(message);
  return ok(listChatMessages(100));
});

export const DELETE = route(async () => {
  clearChat();
  return ok({ cleared: true });
});
