import { z } from "zod";
import { defineTool } from "../types";
import type { EmailRow } from "@/database/types";
import { assetStatus } from "@/documents/assets";

/**
 * Tools carnet d'adresses et sociétés. Les adresses proviennent uniquement de
 * `config/contacts.json` et des expéditeurs réellement reçus dans la mailbox :
 * aucune adresse n'est inventée. Les sociétés n'exposent JAMAIS de chemin de
 * fichier de signature ou de tampon : seulement `configured` / `available`.
 */
const contactSchema = z.object({
  contact_id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  internal: z.boolean(),
  source: z.enum(["contacts", "mailbox"]),
  last_seen_at: z.string().nullable(),
});

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export const searchContacts = defineTool({
  name: "search_contacts",
  description: "Recherche un destinataire par nom, prénom, rôle ou adresse, dans les contacts configurés puis dans les expéditeurs déjà reçus. N'invente jamais d'adresse : renvoie 0, 1 ou plusieurs candidats.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ query: z.string().min(1), internal_only: z.boolean().default(false), max: z.number().int().min(1).max(20).default(10) }),
  output: z.array(contactSchema),
  handler: async (input, ctx) => {
    const q = normalize(input.query);
    const out: z.infer<typeof contactSchema>[] = [];
    for (const c of ctx.contacts) {
      if (input.internal_only && !c.internal) continue;
      if (normalize(`${c.name} ${c.email} ${c.role}`).includes(q)) {
        out.push({ contact_id: c.id, name: c.name, email: c.email, role: c.role, internal: c.internal, source: "contacts", last_seen_at: null });
      }
    }
    if (!input.internal_only) {
      const rows = ctx.db
        .prepare(
          `SELECT * FROM emails WHERE direction = 'inbound' AND sender_email IS NOT NULL
           GROUP BY lower(sender_email) ORDER BY max(received_at) DESC LIMIT 400`,
        )
        .all() as EmailRow[];
      for (const e of rows) {
        const email = e.sender_email;
        if (!email || out.some((c) => normalize(c.email) === normalize(email))) continue;
        if (!normalize(`${e.sender_name ?? ""} ${email}`).includes(q)) continue;
        out.push({ contact_id: `mailbox:${email}`, name: e.sender_name ?? email, email, role: "", internal: false, source: "mailbox", last_seen_at: e.received_at });
      }
    }
    return out.slice(0, input.max);
  },
});

export const getCompany = defineTool({
  name: "get_company",
  description: "Renvoie les sociétés configurées (identifiant, nom, signataire) et indique si une signature et un tampon sont disponibles. Ne renvoie jamais de fichier ni de chemin.",
  riskLevel: "LOW",
  modes: ["chat"],
  input: z.object({ company_id: z.string().optional(), query: z.string().optional() }),
  output: z.array(
    z.object({
      company_id: z.string(),
      name: z.string(),
      legal_name: z.string().nullable(),
      signer_name: z.string().nullable(),
      signer_title: z.string().nullable(),
      quote_approval_text: z.string(),
      signature_available: z.boolean(),
      stamp_available: z.boolean(),
      stamp_required: z.boolean(),
    }),
  ),
  handler: async (input, ctx) => {
    const q = input.query ? normalize(input.query) : null;
    return ctx.companies
      .filter((c) => (input.company_id ? c.id === input.company_id : true))
      .filter((c) => (q ? normalize(`${c.id} ${c.name} ${c.legalName ?? ""} ${c.aliases.join(" ")}`).includes(q) : true))
      .map((c) => ({
        company_id: c.id,
        name: c.name,
        legal_name: c.legalName ?? null,
        signer_name: c.signatory?.name ?? null,
        signer_title: c.signatory?.title ?? null,
        quote_approval_text: c.quoteApprovalText,
        signature_available: assetStatus(c, "signature").available,
        stamp_available: assetStatus(c, "stamp").available,
        stamp_required: c.stampRequired,
      }));
  },
});

export const contactTools = [searchContacts, getCompany];
