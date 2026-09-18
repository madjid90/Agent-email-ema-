import { EmaError } from "@/lib/errors";
import type { ComposioTool } from "./client";

/**
 * Politique LECTURE SEULE du POC, fail-closed : un tool n'est exécutable que
 * s'il appartient au toolkit Outlook, correspond à une opération autorisée ET
 * ne contient aucun verbe d'écriture. Tout le reste est refusé, y compris un
 * tool inconnu ou ambigu.
 */
export const POC_TOOLKIT = "outlook";

/** Opérations que le POC expose. Rien d'autre n'est exécutable. */
export type ReadOperation = "list_recent" | "search" | "get_message" | "list_attachments" | "get_attachment" | "list_events" | "get_profile";

/** Verbes d'écriture / destructifs : tout slug qui en contient un est refusé, sans exception. */
export const WRITE_VERBS = /(SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|SET_|ADD_|REMOVE|UPLOAD|WRITE|DRAFT|ARCHIVE|TRASH|FLAG|CATEGOR|RULE|SUBSCRI|COPY|BATCH|PATCH|POST|PUT_|IMPORT|RESPOND|ACCEPT|DECLINE|CANCEL|EDIT|MODIFY|CHANGE|CLEAR|PURGE|RESTORE|INVITE|SHARE|GRANT|REVOKE|PUBLISH|COMPOSE|SCHEDULE|SNOOZE|UNSUBSCRIBE|TENTATIVE|REPORT|EMPTY|MANAGE|ASSIGN|APPLY|ENABLE|DISABLE|TRIGGER)/;

/** Verbes de lecture : au moins un est requis. */
export const READ_VERBS = /(LIST|GET|SEARCH|FETCH|READ|FIND|RETRIEVE|DOWNLOAD|VIEW)/;

/**
 * Candidats par opération, par ordre de préférence. Les slugs Outlook n'ont
 * pas pu être vérifiés hors ligne (documentation Composio inaccessible depuis
 * l'environnement de développement) : ils sont RÉSOLUS à l'exécution contre la
 * liste réelle des tools du toolkit, filtrée par la politique. Un candidat
 * absent n'est jamais exécuté « au hasard » : l'opération échoue proprement en
 * indiquant les slugs de lecture réellement disponibles.
 */
export const OPERATION_CANDIDATES: Record<ReadOperation, RegExp[]> = {
  list_recent: [/^OUTLOOK_OUTLOOK_LIST_MESSAGES$/, /^OUTLOOK_LIST_MESSAGES$/, /LIST_MESSAGES$/, /LIST_MAIL/, /GET_MESSAGES$/, /LIST_EMAILS$/],
  search: [/^OUTLOOK_OUTLOOK_SEARCH_(EMAILS|MESSAGES)$/, /SEARCH_(EMAILS|MESSAGES|MAIL)/, /SEARCH/],
  get_message: [/^OUTLOOK_OUTLOOK_GET_MESSAGE$/, /GET_MESSAGE$/, /GET_EMAIL$/, /GET_MAIL$/],
  list_attachments: [/LIST_ATTACHMENTS?$/, /GET_ATTACHMENTS$/, /MESSAGE_ATTACHMENTS/],
  get_attachment: [/GET_ATTACHMENT$/, /DOWNLOAD_ATTACHMENT/, /ATTACHMENT_CONTENT/],
  list_events: [/^OUTLOOK_OUTLOOK_CALENDAR_LIST_EVENTS$/, /LIST_EVENTS$/, /CALENDAR_VIEW/, /GET_EVENTS$/, /LIST_CALENDAR_EVENTS/],
  get_profile: [/^OUTLOOK_OUTLOOK_GET_PROFILE$/, /GET_PROFILE$/, /GET_ME$/, /GET_CURRENT_USER/, /USER_PROFILE/],
};

/** `true` si le tool est un tool de LECTURE du toolkit Outlook selon la politique. */
export function isReadOnlyTool(tool: Pick<ComposioTool, "slug" | "toolkit" | "deprecated">): boolean {
  const slug = tool.slug.toUpperCase();
  if (tool.toolkit.toLowerCase() !== POC_TOOLKIT) return false;
  if (tool.deprecated) return false;
  if (WRITE_VERBS.test(slug)) return false;
  return READ_VERBS.test(slug);
}

/** Vérification finale juste avant exécution : lève si le slug n'est pas autorisé. */
export function assertReadOnlySlug(slug: string, known: Pick<ComposioTool, "slug" | "toolkit" | "deprecated">[]): void {
  const upper = slug.toUpperCase();
  const tool = known.find((t) => t.slug === upper);
  if (!tool) throw new EmaError("FORBIDDEN", `Tool ${upper} inconnu du toolkit ${POC_TOOLKIT} : exécution refusée`);
  if (!isReadOnlyTool(tool)) throw new EmaError("FORBIDDEN", `Tool ${upper} refusé par la politique lecture seule du POC`);
}

/** Résout l'opération vers le premier slug candidat réellement disponible ET autorisé. */
export function resolveOperation(op: ReadOperation, tools: ComposioTool[]): ComposioTool {
  const allowed = tools.filter(isReadOnlyTool);
  for (const pattern of OPERATION_CANDIDATES[op]) {
    const match = allowed.find((t) => pattern.test(t.slug));
    if (match) return match;
  }
  const available = allowed.map((t) => t.slug).sort().join(", ") || "aucun";
  throw new EmaError("NOT_IMPLEMENTED", `Aucun tool de lecture Composio ne correspond à l'opération « ${op} ». Tools de lecture disponibles : ${available}`);
}

/** Classement d'une liste de tools pour l'écran de diagnostic. */
export function classifyTools(tools: ComposioTool[]): { allowed: ComposioTool[]; blocked: ComposioTool[] } {
  const allowed: ComposioTool[] = [];
  const blocked: ComposioTool[] = [];
  for (const t of tools) (isReadOnlyTool(t) ? allowed : blocked).push(t);
  return { allowed, blocked };
}
