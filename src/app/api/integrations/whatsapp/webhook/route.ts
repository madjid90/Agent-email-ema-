import { NextResponse } from "next/server";
import { bootstrap } from "@/lib/bootstrap";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { handleWhatsappEvent, parseWebhook, verifySignature, verifySubscription } from "@/integrations/whatsapp";

const log = createLogger("whatsapp.webhook");

/** Vérification de l'abonnement Meta (hub.challenge). Route publique. */
export async function GET(req: Request): Promise<NextResponse> {
  bootstrap();
  const challenge = verifySubscription(new URL(req.url).searchParams, getEnv().WHATSAPP_VERIFY_TOKEN);
  if (challenge === null) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Réception des événements. Route publique protégée par la signature
 * X-Hub-Signature-256 (obligatoire en production) ; toujours 200 après
 * vérification pour éviter les rejeux Meta, le dédoublonnage est en base.
 */
export async function POST(req: Request): Promise<NextResponse> {
  bootstrap();
  const env = getEnv();
  const raw = await req.text();
  if (env.WHATSAPP_APP_SECRET) {
    if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)) {
      log.warn("webhook signature invalid");
      return new NextResponse("Invalid signature", { status: 401 });
    }
  } else if (env.NODE_ENV === "production") {
    log.error("webhook refused: WHATSAPP_APP_SECRET missing in production");
    return new NextResponse("Webhook not configured", { status: 503 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }
  const events = parseWebhook(json);
  const results: string[] = [];
  for (const event of events) {
    try {
      const r = await handleWhatsappEvent(event);
      results.push(r.outcome);
    } catch (err) {
      log.error("webhook event failed", { message: err instanceof Error ? err.message : String(err) });
      results.push("error");
    }
  }
  return NextResponse.json({ ok: true, processed: results.length, results });
}
