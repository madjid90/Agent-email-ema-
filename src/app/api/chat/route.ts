import { z } from "zod";
import { route, ok, parseBody, currentUser } from "@/lib/api";
import { listChatMessages, clearChat } from "@/database/repositories/chat";
import { getConfiguredIntegrations } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { runChatTurn } from "@/agent/chat";

/** Chat web : même utilisateur EMA que sur WhatsApp, conversation séparée par canal, jamais mélangée entre comptes. */
export const GET = route(async (_req, _ctx, sessionUser) => ok(listChatMessages(100, undefined, "WEB", currentUser(sessionUser).id)));

export const POST = route(async (req, _ctx, sessionUser) => {
  const user = currentUser(sessionUser);
  const { message } = await parseBody(req, z.object({ message: z.string().min(1).max(4000) }));
  if (!getConfiguredIntegrations().anthropic) throw new EmaError("CONFIG", "ANTHROPIC_API_KEY non renseignée : le chat est indisponible");
  await runChatTurn(message, { userId: user.id, userName: user.name });
  return ok(listChatMessages(100, undefined, "WEB", user.id));
});

export const DELETE = route(async (_req, _ctx, sessionUser) => {
  clearChat(undefined, "WEB", currentUser(sessionUser).id);
  return ok({ cleared: true });
});
