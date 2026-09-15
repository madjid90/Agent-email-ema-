import type { GraphMessage } from "@/integrations/microsoft/types";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (call: RecordedCall, n: number) => Response | Promise<Response>;

/** Faux fetch : routes par regex sur "METHOD url", compteur d'appels par route. */
export function fakeFetch(routes: { match: RegExp; handle: Handler }[]) {
  const calls: RecordedCall[] = [];
  const counters = new Map<RegExp, number>();
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body.entries());
    }
    const call: RecordedCall = { method, url, headers, body };
    calls.push(call);
    const key = `${method} ${url}`;
    for (const r of routes) {
      if (r.match.test(key)) {
        const n = (counters.get(r.match) ?? 0) + 1;
        counters.set(r.match, n);
        return r.handle(call, n);
      }
    }
    return json({ error: { code: "NotFound", message: `no fake route for ${key}` } }, 404);
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function binary(bytes: Buffer, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { "content-type": "application/octet-stream" } });
}

export function message(overrides: Partial<GraphMessage> & { id: string }): GraphMessage {
  return {
    conversationId: "conv-1",
    internetMessageId: `<${overrides.id}@example.com>`,
    subject: `Sujet ${overrides.id}`,
    bodyPreview: "Aperçu",
    body: { contentType: "text", content: `Corps de ${overrides.id}` },
    from: { emailAddress: { name: "Client", address: "client@ext.fr" } },
    toRecipients: [{ emailAddress: { address: "moi@entreprise.fr" } }],
    receivedDateTime: "2026-09-15T10:00:00Z",
    sentDateTime: "2026-09-15T09:59:00Z",
    hasAttachments: false,
    isRead: false,
    isDraft: false,
    webLink: "https://outlook.office.com/x",
    ...overrides,
  };
}

export const noSleep = async (): Promise<void> => {};
