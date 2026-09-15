/** Types Microsoft Graph (sous-ensemble utilisé par EMA) et jeu de tokens. */

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress: GraphEmailAddress;
}

export interface GraphBody {
  contentType: "text" | "html";
  content: string;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: GraphBody;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  isRead?: boolean;
  isDraft?: boolean;
  webLink?: string;
  parentFolderId?: string;
  "@removed"?: { reason: string };
}

export interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentBytes?: string;
}

export interface GraphPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphErrorBody {
  error?: { code?: string; message?: string; innerError?: Record<string, unknown> };
}

export interface GraphUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** ISO UTC */
  expiresAt: string;
  scope: string;
}

export interface OutlookSyncResult {
  inserted: number;
  updated: number;
  skipped: number;
  attachments: number;
  pages: number;
  reachedLimit: boolean;
  lastEmailAt: string | null;
  errors: string[];
}
