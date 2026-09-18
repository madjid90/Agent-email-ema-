import { z } from "zod";
import { route, ok, parseBody, currentUser } from "@/lib/api";
import { runPocRead } from "@/integrations/composio/outlook-poc";
import { requirePoc } from "../_guard";

/**
 * Opérations de LECTURE uniquement. Le client choisit une opération, jamais un
 * slug : la résolution et la politique lecture seule sont côté serveur.
 */
const bodySchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list_recent"), limit: z.number().int().min(1).max(10).default(5) }),
  z.object({ operation: z.literal("search"), query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).default(5) }),
  z.object({ operation: z.literal("get_message"), message_id: z.string().trim().min(1).max(400) }),
  z.object({ operation: z.literal("list_attachments"), message_id: z.string().trim().min(1).max(400) }),
  z.object({ operation: z.literal("get_attachment"), message_id: z.string().trim().min(1).max(400), attachment_id: z.string().trim().min(1).max(400) }),
  z.object({ operation: z.literal("list_events"), limit: z.number().int().min(1).max(10).default(5) }),
]);

export const POST = route(async (req, _ctx, sessionUser) => {
  requirePoc();
  const user = currentUser(sessionUser);
  const body = await parseBody(req, bodySchema);
  const { operation, ...args } = body;
  const canonical: Record<string, unknown> = { ...args };
  if (operation === "list_events") {
    const now = new Date();
    canonical.start = now.toISOString();
    canonical.end = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  }
  return ok(await runPocRead(user, operation, canonical));
});
