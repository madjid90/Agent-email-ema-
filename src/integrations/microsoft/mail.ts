import type { GraphClient } from "./graph-client";
import type { GraphMessage, GraphPage, GraphRecipient, GraphUser } from "./types";
import type { NewEmail } from "@/database/repositories/emails";

/** Champs demandés à Graph pour un message (jamais tout l'objet). */
export const MESSAGE_SELECT =
  "id,conversationId,internetMessageId,subject,bodyPreview,body,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isRead,isDraft,webLink,parentFolderId";

/** Corps en texte brut plutôt qu'en HTML. */
export const TEXT_BODY_HEADER = { Prefer: 'outlook.body-content-type="text"' } as const;

export const MAX_BODY_CHARS = 40_000;

export function addresses(list: GraphRecipient[] | undefined): string[] {
  return (list ?? []).map((r) => r.emailAddress?.address ?? "").filter((a) => a.length > 0);
}

export function toNewEmail(m: GraphMessage, opts: { direction?: "inbound" | "outbound"; status?: NewEmail["status"]; accountEmail?: string | null } = {}): NewEmail {
  const senderEmail = m.from?.emailAddress?.address ?? m.sender?.emailAddress?.address ?? null;
  const direction = opts.direction ?? (opts.accountEmail && senderEmail && senderEmail.toLowerCase() === opts.accountEmail.toLowerCase() ? "outbound" : "inbound");
  const body = m.body?.content ?? "";
  return {
    graphId: m.id,
    threadId: m.conversationId ?? null,
    internetMessageId: m.internetMessageId ?? null,
    direction,
    senderName: m.from?.emailAddress?.name ?? m.sender?.emailAddress?.name ?? null,
    senderEmail,
    toRecipients: addresses(m.toRecipients),
    ccRecipients: addresses(m.ccRecipients),
    subject: m.subject ?? "",
    bodyPreview: (m.bodyPreview ?? "").slice(0, 500),
    bodyText: m.body?.contentType === "html" ? htmlToText(body).slice(0, MAX_BODY_CHARS) : body.slice(0, MAX_BODY_CHARS),
    receivedAt: m.receivedDateTime ?? m.sentDateTime ?? new Date().toISOString(),
    sentAt: m.sentDateTime ?? null,
    hasAttachments: Boolean(m.hasAttachments),
    isRead: Boolean(m.isRead),
    webLink: m.webLink ?? null,
    folder: m.parentFolderId ?? null,
    status: opts.status ?? "NEW",
  };
}

/** Conversion HTML → texte minimale (secours si Graph ignore le header Prefer). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* Lecture ------------------------------------------------------------------ */

export async function getMe(client: GraphClient): Promise<{ email: string | null; displayName: string | null }> {
  const me = await client.get<GraphUser>("/me", { $select: "id,displayName,mail,userPrincipalName" });
  return { email: me.mail ?? me.userPrincipalName ?? null, displayName: me.displayName ?? null };
}

export async function getMessage(client: GraphClient, messageId: string): Promise<GraphMessage> {
  return client.get<GraphMessage>(`/me/messages/${encodeURIComponent(messageId)}`, { $select: MESSAGE_SELECT }, TEXT_BODY_HEADER);
}

export interface DeltaPage {
  messages: GraphMessage[];
  removed: string[];
  nextLink: string | null;
  deltaLink: string | null;
}

/**
 * Une page de delta sur la boîte de réception. `cursor` est un nextLink ou un
 * deltaLink conservé localement ; sans curseur, requête initiale (bornée par
 * `initialSince` pour ne pas relire toute la boîte).
 */
export async function fetchInboxDeltaPage(client: GraphClient, cursor: string | null, opts: { initialSince?: string | null; pageSize?: number } = {}): Promise<DeltaPage> {
  const headers = { ...TEXT_BODY_HEADER, Prefer: `${TEXT_BODY_HEADER.Prefer}, odata.maxpagesize=${opts.pageSize ?? 50}` };
  const page = cursor
    ? await client.get<GraphPage<GraphMessage>>(cursor, undefined, headers)
    : await client.get<GraphPage<GraphMessage>>(
        "/me/mailFolders/inbox/messages/delta",
        { $select: MESSAGE_SELECT, ...(opts.initialSince ? { $filter: `receivedDateTime ge ${opts.initialSince}` } : {}) },
        headers,
      );
  const messages: GraphMessage[] = [];
  const removed: string[] = [];
  for (const m of page.value) {
    if (m["@removed"]) removed.push(m.id);
    else messages.push(m);
  }
  return { messages, removed, nextLink: page["@odata.nextLink"] ?? null, deltaLink: page["@odata.deltaLink"] ?? null };
}

/** Tous les messages d'une conversation (tous dossiers), triés du plus ancien au plus récent. */
export async function listConversation(client: GraphClient, conversationId: string, max = 30): Promise<GraphMessage[]> {
  const items = await client.getAll<GraphMessage>(
    "/me/messages",
    { $filter: `conversationId eq '${escapeOData(conversationId)}'`, $select: MESSAGE_SELECT, $top: Math.min(max, 50) },
    { limit: max, headers: TEXT_BODY_HEADER },
  );
  return items.filter((m) => !m.isDraft).sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
}

export interface SearchOptions {
  query: string;
  from?: string;
  since?: string;
  max?: number;
}

/** Recherche KQL via $search (objet, corps, expéditeur). */
export async function searchMessages(client: GraphClient, opts: SearchOptions): Promise<GraphMessage[]> {
  const terms = [`"${opts.query.replace(/"/g, " ")}"`];
  if (opts.from) terms.push(`from:${opts.from.replace(/[\s"]/g, "")}`);
  if (opts.since) terms.push(`received>=${opts.since.slice(0, 10)}`);
  const max = Math.min(opts.max ?? 10, 50);
  const page = await client.get<GraphPage<GraphMessage>>("/me/messages", { $search: terms.join(" "), $select: MESSAGE_SELECT, $top: max }, TEXT_BODY_HEADER);
  return page.value.filter((m) => !m.isDraft).slice(0, max);
}

/** Dernier message envoyé d'une conversation (pour tracer une réponse EMA). */
export async function findLatestSentInConversation(client: GraphClient, conversationId: string, sinceIso: string): Promise<GraphMessage | null> {
  const items = await client.getAll<GraphMessage>(
    "/me/mailFolders/sentitems/messages",
    { $filter: `conversationId eq '${escapeOData(conversationId)}'`, $select: MESSAGE_SELECT, $top: 10 },
    { limit: 10, headers: TEXT_BODY_HEADER },
  );
  const candidates = items.filter((m) => (m.sentDateTime ?? "") >= sinceIso).sort((a, b) => (b.sentDateTime ?? "").localeCompare(a.sentDateTime ?? ""));
  return candidates[0] ?? null;
}

/** Messages envoyés depuis un instant donné (réconciliation après envoi ambigu). */
export async function listSentSince(client: GraphClient, sinceIso: string, max = 25): Promise<GraphMessage[]> {
  const items = await client.getAll<GraphMessage>(
    "/me/mailFolders/sentitems/messages",
    { $filter: `sentDateTime ge ${sinceIso}`, $select: MESSAGE_SELECT, $top: Math.min(max, 50), $orderby: "sentDateTime desc" },
    { limit: max, headers: TEXT_BODY_HEADER },
  );
  return items.sort((a, b) => (b.sentDateTime ?? "").localeCompare(a.sentDateTime ?? ""));
}

/* Envoi : primitives appelées UNIQUEMENT par les exécuteurs de l'Action Engine ---- */

export interface OutgoingAttachment {
  name: string;
  contentType: string;
  contentBytesBase64: string;
}

function recipients(list: string[]): GraphRecipient[] {
  return list.map((address) => ({ emailAddress: { address } }));
}

function fileAttachments(list: OutgoingAttachment[] | undefined) {
  return (list ?? []).map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType, contentBytes: a.contentBytesBase64 }));
}

export async function replyToMessage(client: GraphClient, messageId: string, input: { comment: string; replyAll?: boolean; attachments?: OutgoingAttachment[] }): Promise<void> {
  const path = `/me/messages/${encodeURIComponent(messageId)}/${input.replyAll ? "replyAll" : "reply"}`;
  const body = input.attachments?.length ? { comment: input.comment, message: { attachments: fileAttachments(input.attachments) } } : { comment: input.comment };
  await client.post<void>(path, body);
}

export async function forwardMessage(client: GraphClient, messageId: string, input: { to: string[]; comment: string }): Promise<void> {
  await client.post<void>(`/me/messages/${encodeURIComponent(messageId)}/forward`, { toRecipients: recipients(input.to), comment: input.comment });
}

export async function sendMail(client: GraphClient, input: { to: string[]; cc?: string[]; subject: string; body: string; attachments?: OutgoingAttachment[] }): Promise<void> {
  await client.post<void>("/me/sendMail", {
    message: {
      subject: input.subject,
      body: { contentType: "Text", content: input.body },
      toRecipients: recipients(input.to),
      ...(input.cc?.length ? { ccRecipients: recipients(input.cc) } : {}),
      ...(input.attachments?.length ? { attachments: fileAttachments(input.attachments) } : {}),
    },
    saveToSentItems: true,
  });
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}
