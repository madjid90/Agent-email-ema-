import { getEnv, getApproverPhone } from "@/lib/env";
import { EmaError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import type { WhatsappOutgoingMessage, WhatsappSendResponse } from "./types";

const log = createLogger("whatsapp");

export class WhatsappError extends EmaError {
  readonly httpStatus: number;
  readonly metaCode: number | null;
  readonly retryable: boolean;
  constructor(httpStatus: number, metaCode: number | null, message: string, retryable: boolean) {
    super("INTEGRATION", message, { status: 502, details: { httpStatus, metaCode } });
    this.name = "WhatsappError";
    this.httpStatus = httpStatus;
    this.metaCode = metaCode;
    this.retryable = retryable;
  }
}

export interface WhatsappClientOptions {
  accessToken: string;
  phoneNumberId: string;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseUrl?: string;
}

/**
 * Client WhatsApp Business Cloud API. Seule classe à manipuler le token ;
 * jamais loggué, jamais renvoyé.
 */
export class WhatsappClient {
  private readonly o: Required<WhatsappClientOptions>;

  constructor(options: WhatsappClientOptions) {
    this.o = {
      apiVersion: "v21.0",
      fetchImpl: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      maxRetries: 2,
      baseUrl: "https://graph.facebook.com",
      ...options,
    };
  }

  async send(message: WhatsappOutgoingMessage): Promise<{ messageId: string }> {
    const url = `${this.o.baseUrl}/${this.o.apiVersion}/${this.o.phoneNumberId}/messages`;
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.o.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify(message),
        });
      } catch (err) {
        if (attempt < this.o.maxRetries) {
          attempt++;
          await this.o.sleep(1000 * attempt);
          continue;
        }
        throw new EmaError("INTEGRATION", "WhatsApp injoignable", { cause: err });
      }
      let body: WhatsappSendResponse = {};
      try {
        body = (await res.json()) as WhatsappSendResponse;
      } catch {
        /* corps vide */
      }
      if (res.ok) {
        const id = body.messages?.[0]?.id;
        if (!id) throw new WhatsappError(res.status, null, "Réponse WhatsApp sans identifiant de message", false);
        return { messageId: id };
      }
      const metaCode = body.error?.code ?? null;
      const retryable = res.status === 429 || res.status >= 500 || metaCode === 4 || metaCode === 80007 || metaCode === 130429;
      if (retryable && attempt < this.o.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.o.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : 1000 * 2 ** attempt);
        continue;
      }
      const text = describeError(res.status, metaCode, body.error?.message);
      log.warn("whatsapp send failed", { status: res.status, metaCode });
      throw new WhatsappError(res.status, metaCode, text, retryable);
    }
  }
}

function describeError(status: number, code: number | null, detail?: string): string {
  const base =
    status === 401 || code === 190
      ? "Token WhatsApp invalide ou expiré"
      : status === 400
        ? "Requête WhatsApp refusée par Meta"
        : status === 429 || code === 4 || code === 130429
          ? "Limite de débit WhatsApp atteinte"
          : status >= 500
            ? "Erreur serveur WhatsApp"
            : `Erreur WhatsApp (${status})`;
  return detail ? `${base} : ${detail.slice(0, 160)}` : base;
}

/* Singleton relié à l'environnement --------------------------------------- */

let override: WhatsappClient | null = null;

export function getWhatsappClient(): WhatsappClient {
  if (override) return override;
  const env = getEnv();
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) throw new EmaError("CONFIG", "WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID manquants");
  return new WhatsappClient({ accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, apiVersion: env.WHATSAPP_API_VERSION });
}

export function setWhatsappClientForTests(client: WhatsappClient | null): void {
  override = client;
}

export function isWhatsappConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_VERIFY_TOKEN && getApproverPhone());
}
