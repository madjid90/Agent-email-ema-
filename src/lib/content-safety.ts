import path from "node:path";

/**
 * Politique de restitution des fichiers archivés (phase 8A).
 * Un document provenant d'un email est du contenu NON FIABLE : il ne doit jamais
 * pouvoir s'exécuter dans l'origine EMA (vol de session, appels API authentifiés).
 * Seul le PDF est affiché en ligne ; tout le reste est téléchargé.
 */

/** Types interprétés par le navigateur : jamais rendus dans l'origine EMA. */
const ACTIVE_MIME = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/xhtml|text\/xsl|application\/rdf\+xml|multipart\/related|message\/rfc822|application\/x-shockwave-flash)/i;

/** Extensions de contenu actif, même si le MIME annoncé est anodin. */
export const ACTIVE_EXTENSIONS = new Set(["html", "htm", "xhtml", "xht", "shtml", "svg", "svgz", "xml", "xsl", "xslt", "mht", "mhtml", "eml", "swf", "wasm"]);

export const INLINE_MIME = "application/pdf";

export function extensionOf(name: string): string {
  return path.extname(name).replace(".", "").toLowerCase();
}

/** Contenu susceptible d'être interprété par le navigateur (MIME ou extension). */
export function isActiveContent(name: string, mimeType: string | null | undefined): boolean {
  if (mimeType && ACTIVE_MIME.test(mimeType)) return true;
  return ACTIVE_EXTENSIONS.has(extensionOf(name));
}

export interface ServedFilePolicy {
  /** Type MIME réellement envoyé au navigateur. */
  contentType: string;
  /** `inline` uniquement pour un PDF authentique ; `attachment` sinon. */
  disposition: "inline" | "attachment";
  /** Nom de fichier assaini pour l'en-tête Content-Disposition. */
  filename: string;
  headers: Record<string, string>;
}

/**
 * Décide comment servir un fichier privé. Un PDF (MIME + extension) est affiché
 * en ligne ; tout le reste est téléchargé, et un contenu actif est en plus
 * neutralisé en `application/octet-stream` pour qu'aucun sniffing ne le rende.
 */
export function servedFilePolicy(name: string, mimeType: string | null | undefined): ServedFilePolicy {
  const filename = name.replace(/[\r\n"\\]/g, "_").slice(0, 150) || "document";
  const ext = extensionOf(filename);
  const active = isActiveContent(filename, mimeType);
  const isPdf = !active && (mimeType ?? "").toLowerCase().startsWith(INLINE_MIME) && ext === "pdf";
  const contentType = active ? "application/octet-stream" : isPdf ? INLINE_MIME : (mimeType ?? "application/octet-stream");
  return {
    contentType,
    disposition: isPdf ? "inline" : "attachment",
    filename,
    headers: {
      "content-type": contentType,
      "content-disposition": `${isPdf ? "inline" : "attachment"}; filename="${filename}"`,
      // Empêche le navigateur de deviner un type exécutable à partir du contenu.
      "x-content-type-options": "nosniff",
      // Aucune ressource, aucun script : même servi, le fichier ne peut rien faire.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; sandbox",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  };
}
