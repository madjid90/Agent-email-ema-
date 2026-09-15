import { z } from "zod";
import { route, ok, parseBody } from "@/lib/api";
import { listChatMessages, clearChat } from "@/database/repositories/chat";
import { NotImplementedError } from "@/lib/errors";

export const GET = route(async () => ok(listChatMessages(100)));

export const POST = route(async (req) => {
  await parseBody(req, z.object({ message: z.string().min(1).max(4000) }));
  throw new NotImplementedError("Chat EMA (Claude + tools)", "phase 2");
});

export const DELETE = route(async () => {
  clearChat();
  return ok({ cleared: true });
});
