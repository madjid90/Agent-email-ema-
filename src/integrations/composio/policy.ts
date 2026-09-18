import { EmaError } from "@/lib/errors";
import type { ComposioTool } from "./client";

/**
 * Politique LECTURE SEULE du POC, fail-closed : un tool n'est exécutable que
 * s'il appartient au toolkit Outlook, figure dans la table déterministe
 * ci-dessous pour l'opération demandée, ET ne contient aucun verbe d'écriture.
 * Tout le reste est refusé, y compris un tool inconnu, ambigu ou déprécié.
 */
export const POC_TOOLKIT = "outlook";

/** Opérations que le POC expose. Rien d'autre n'est exécutable. */
export type ReadOperation = "list_recent" | "search" | "get_message" | "list_attachments" | "get_attachment" | "list_events" | "get_profile";

/** Verbes d'écriture / destructifs : tout slug qui en contient un est refusé, sans exception. */
export const WRITE_VERBS = /(SEND|REPLY|FORWARD|DELETE|MOVE|CREATE|UPDATE|MARK|SET_|ADD_|REMOVE|UPLOAD|WRITE|DRAFT|ARCHIVE|TRASH|FLAG|CATEGOR|RULE|SUBSCRI|COPY|BATCH|PATCH|POST|PUT_|IMPORT|RESPOND|ACCEPT|DECLINE|CANCEL|EDIT|MODIFY|CHANGE|CLEAR|PURGE|RESTORE|INVITE|SHARE|GRANT|REVOKE|PUBLISH|COMPOSE|SCHEDULE|SNOOZE|UNSUBSCRIBE|TENTATIVE|REPORT|EMPTY|MANAGE|ASSIGN|APPLY|ENABLE|DISABLE|TRIGGER)/;

/** Verbes de lecture : au moins un est requis. */
export const READ_VERBS = /(LIST|GET|SEARCH|QUERY|FETCH|READ|FIND|RETRIEVE|DOWNLOAD|VIEW)/;

/**
 * Table DÉTERMINISTE et restrictive : slugs exacts du catalogue Outlook Composio
 * actuel, par ordre de préférence. Aucune expression régulière : une opération
 * ne peut se résoudre que vers l'un de ces slugs, jamais vers un tool d'un autre
 * objet métier (ex. `get_attachment` ne résout JAMAIS vers un tool d'événement
 * de calendrier tel que OUTLOOK_GET_EVENT_ATTACHMENT). Un slug absent du
 * catalogue réel n'est jamais exécuté : l'opération échoue proprement.
 */
export const OPERATION_TOOLS: Record<ReadOperation, readonly string[]> = {
  list_recent: ["OUTLOOK_LIST_MESSAGES"],
  search: ["OUTLOOK_SEARCH_MESSAGES", "OUTLOOK_QUERY_EMAILS"],
  get_message: ["OUTLOOK_GET_MESSAGE"],
  list_attachments: ["OUTLOOK_LIST_OUTLOOK_ATTACHMENTS"],
  get_attachment: ["OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT"],
  list_events: ["OUTLOOK_LIST_EVENTS"],
  get_profile: ["OUTLOOK_GET_PROFILE"],
};

/** Objet métier attendu par opération : un slug portant un autre objet est refusé même s'il est listé par erreur. */
const FORBIDDEN_DOMAIN: Record<ReadOperation, RegExp | null> = {
  list_recent: /EVENT|CALENDAR|CONTACT|FOLDER|ONEDRIVE|FILE/,
  search: /EVENT|CALENDAR|CONTACT|FOLDER|ONEDRIVE|FILE/,
  get_message: /EVENT|CALENDAR|CONTACT|FOLDER|ONEDRIVE|FILE/,
  list_attachments: /EVENT|CALENDAR|ONEDRIVE|FILE/,
  get_attachment: /EVENT|CALENDAR|ONEDRIVE|FILE/,
  list_events: /MESSAGE|MAIL|ATTACHMENT|CONTACT|ONEDRIVE|FILE/,
  get_profile: /MESSAGE|MAIL|EVENT|CALENDAR|ATTACHMENT|FOLDER/,
};

/**
 * Scopes Microsoft Graph du POC (lecture seule). Composio Managed OAuth attend
 * `credentials.scopes` sous forme de chaîne séparée par des VIRGULES.
 */
export const POC_READ_ONLY_SCOPES = ["openid", "profile", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"] as const;

/** Chaîne à coller dans l'auth config Composio Managed OAuth (ou `credentials.scopes` de l'API). */
export function managedOAuthScopes(): string {
  return POC_READ_ONLY_SCOPES.join(",");
}

/** Ensemble plat des slugs autorisés, toutes opérations confondues. */
export const ALLOWED_SLUGS: ReadonlySet<string> = new Set(Object.values(OPERATION_TOOLS).flat());

/** `true` si le tool est un tool de LECTURE du toolkit Outlook selon la politique (verbes). */
export function isReadOnlyTool(tool: Pick<ComposioTool, "slug" | "toolkit" | "deprecated">): boolean {
  const slug = tool.slug.toUpperCase();
  if (tool.toolkit.toLowerCase() !== POC_TOOLKIT) return false;
  if (tool.deprecated) return false;
  if (WRITE_VERBS.test(slug)) return false;
  return READ_VERBS.test(slug);
}

/** `true` si le tool est à la fois de lecture ET dans la table déterministe : le seul cas exécutable. */
export function isExecutableTool(tool: Pick<ComposioTool, "slug" | "toolkit" | "deprecated">): boolean {
  return isReadOnlyTool(tool) && ALLOWED_SLUGS.has(tool.slug.toUpperCase());
}

/** Vérification finale juste avant exécution : lève si le slug n'est pas exécutable pour cette opération. */
export function assertReadOnlySlug(slug: string, known: Pick<ComposioTool, "slug" | "toolkit" | "deprecated">[], operation?: ReadOperation): void {
  const upper = slug.toUpperCase();
  const tool = known.find((t) => t.slug === upper);
  if (!tool) throw new EmaError("FORBIDDEN", `Tool ${upper} inconnu du toolkit ${POC_TOOLKIT} : exécution refusée`);
  if (!isReadOnlyTool(tool)) throw new EmaError("FORBIDDEN", `Tool ${upper} refusé par la politique lecture seule du POC`);
  if (!ALLOWED_SLUGS.has(upper)) throw new EmaError("FORBIDDEN", `Tool ${upper} hors de la table autorisée du POC : exécution refusée`);
  if (operation) {
    if (!OPERATION_TOOLS[operation].includes(upper)) throw new EmaError("FORBIDDEN", `Tool ${upper} non autorisé pour l'opération ${operation}`);
    const forbidden = FORBIDDEN_DOMAIN[operation];
    if (forbidden && forbidden.test(upper)) throw new EmaError("FORBIDDEN", `Tool ${upper} porte sur un autre objet métier que ${operation} : exécution refusée`);
  }
}

/** Résout l'opération vers le premier slug de la table réellement présent dans le catalogue ET autorisé. */
export function resolveOperation(op: ReadOperation, tools: ComposioTool[]): ComposioTool {
  const bySlug = new Map(tools.map((t) => [t.slug.toUpperCase(), t]));
  const forbidden = FORBIDDEN_DOMAIN[op];
  for (const slug of OPERATION_TOOLS[op]) {
    const tool = bySlug.get(slug);
    if (!tool) continue;
    if (!isReadOnlyTool(tool)) continue;
    if (forbidden && forbidden.test(slug)) continue;
    return tool;
  }
  const available = tools.filter(isReadOnlyTool).map((t) => t.slug).sort().join(", ") || "aucun";
  throw new EmaError("NOT_IMPLEMENTED", `Aucun tool autorisé pour l'opération « ${op} » (attendu : ${OPERATION_TOOLS[op].join(" ou ")}). Tools de lecture présents dans le catalogue : ${available}`);
}

/** Classement d'une liste de tools pour l'écran de diagnostic : exécutables / lecture non retenue / refusés. */
export function classifyTools(tools: ComposioTool[]): { allowed: ComposioTool[]; readOnlyUnused: ComposioTool[]; blocked: ComposioTool[] } {
  const allowed: ComposioTool[] = [];
  const readOnlyUnused: ComposioTool[] = [];
  const blocked: ComposioTool[] = [];
  for (const t of tools) {
    if (isExecutableTool(t)) allowed.push(t);
    else if (isReadOnlyTool(t)) readOnlyUnused.push(t);
    else blocked.push(t);
  }
  return { allowed, readOnlyUnused, blocked };
}

export interface ToolsSummary {
  executable: number;
  readOnlyUnused: number;
  blocked: number;
  /** Tools exécutables portant un verbe d'écriture : DOIT valoir 0, sinon le POC est en échec. */
  writeToolsExecutable: number;
  /** Slugs fautifs, pour l'affichage (vide si 0). */
  writeToolsExecutableSlugs: string[];
  pocFailed: boolean;
}

/** Résumé du diagnostic : `writeToolsExecutable` compte les exécutables contenant un verbe d'écriture (invariant : 0). */
export function summarizeTools(classified: ReturnType<typeof classifyTools>): ToolsSummary {
  const offenders = classified.allowed.filter((t) => WRITE_VERBS.test(t.slug.toUpperCase()) || !READ_VERBS.test(t.slug.toUpperCase())).map((t) => t.slug);
  return { executable: classified.allowed.length, readOnlyUnused: classified.readOnlyUnused.length, blocked: classified.blocked.length, writeToolsExecutable: offenders.length, writeToolsExecutableSlugs: offenders, pocFailed: offenders.length > 0 };
}
