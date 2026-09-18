import { createHash } from "node:crypto";

/**
 * Identifiant externe stable et opaque pour les fournisseurs de connexion.
 * On n'envoie ni email ni identifiant interne brut au fournisseur.
 */
export function buildExternalConnectionUserId(organizationId: string, userId: string): string {
  if (!organizationId.trim() || !userId.trim()) {
    throw new Error("organizationId et userId sont obligatoires");
  }

  const digest = createHash("sha256")
    .update(organizationId)
    .update("\0")
    .update(userId)
    .digest("hex");

  return `ema_${digest}`;
}
