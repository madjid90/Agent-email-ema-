import Link from "next/link";
import { Card, ConfidenceBadge, DocTypeBadge, Empty } from "@/components/ui";
import { getDb } from "@/database/connection";
import { searchDocuments } from "@/database/repositories/documents";
import { getEmail } from "@/database/repositories/emails";
import { getCompanies, getSettings } from "@/lib/config";
import { formatAmount, formatDateTime } from "@/lib/time";

export const dynamic = "force-dynamic";

type Tab = "invoices" | "quotes" | "signed" | "proofs" | "review" | "other" | "all";
const TABS: { id: Tab; label: string }[] = [
  { id: "invoices", label: "Factures / avoirs" },
  { id: "quotes", label: "Devis" },
  { id: "signed", label: "Devis signés" },
  { id: "proofs", label: "Justificatifs" },
  { id: "review", label: "À vérifier" },
  { id: "other", label: "Autres" },
  { id: "all", label: "Tous" },
];

const DOC_STATUS: Record<string, { label: string; tone: string }> = {
  received: { label: "À analyser", tone: "" },
  analyzed: { label: "Analysé", tone: "" },
  archived: { label: "Archivé", tone: "" },
  sign_proposed: { label: "À valider", tone: "warn" },
  sign_rejected: { label: "Refusé", tone: "danger" },
  signed: { label: "Signé", tone: "ok" },
  signed_and_sent: { label: "Envoyé", tone: "ok" },
  sent: { label: "Envoyé", tone: "ok" },
  sign_failed: { label: "Échec", tone: "danger" },
};

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const { tab: rawTab, q } = await searchParams;
  const tab: Tab = TABS.some((t) => t.id === rawTab) ? (rawTab as Tab) : "invoices";
  const db = getDb();
  const settings = getSettings();
  const tz = settings.company.timezone;
  const companies = new Map(getCompanies().map((c) => [c.id, c.name]));
  const opts: import("@/database/repositories/documents").DocumentSearch = ({
    invoices: { docType: ["INVOICE", "CREDIT_NOTE"] },
    quotes: { docType: "QUOTE" },
    signed: { category: "signed" as const },
    proofs: { docType: "PAYMENT_PROOF" },
    review: { requiresReview: true },
    other: { docType: ["BANK_DETAILS", "PURCHASE_ORDER", "CONTRACT", "OTHER", "UNKNOWN"] },
    all: {},
  } satisfies Record<Tab, import("@/database/repositories/documents").DocumentSearch>)[tab];
  const docs = searchDocuments({ ...opts, query: q || undefined, limit: 300 }, db);

  return (
    <>
      <h1>Documents</h1>
      <form className="row" style={{ marginBottom: "0.75rem" }}>
        <input type="hidden" name="tab" value={tab} />
        <input name="q" defaultValue={q ?? ""} placeholder="Fournisseur, numéro de facture, nom de fichier…" style={{ maxWidth: 420 }} />
        <button className="btn" type="submit">Rechercher</button>
      </form>
      <div className="tabs">
        {TABS.map((t) => <Link key={t.id} href={`/documents?tab=${t.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={`tab${t.id === tab ? " active" : ""}`}>{t.label}</Link>)}
      </div>
      <Card>
        {docs.length === 0 ? <Empty>Aucun document dans cette catégorie.</Empty> : (
          <table>
            <thead><tr><th>Type</th><th>Fichier</th><th>Email source</th><th>Fournisseur</th><th>Société</th><th>Référence</th><th>Montant</th><th>{tab === "quotes" || tab === "signed" ? "Validité" : "Échéance"}</th><th>Reçu le</th><th>Confiance</th><th>Statut</th></tr></thead>
            <tbody>
              {docs.map((d) => {
                const email = d.email_id ? getEmail(d.email_id, db) : undefined;
                return (
                  <tr key={d.id}>
                    <td><DocTypeBadge type={d.doc_type} /></td>
                    <td><Link href={`/documents/${d.id}`}>{d.name}</Link><br /><span className="muted" style={{ fontSize: "0.8rem" }}>{Math.round(d.size / 1024)} Ko</span></td>
                    <td>{email ? <Link href={`/emails/${email.id}`}>{email.subject || "(sans objet)"}</Link> : "—"}</td>
                    <td>{d.supplier_name ?? "—"}</td>
                    <td>{d.company_id ? companies.get(d.company_id) ?? d.company_id : "—"}</td>
                    <td>{d.invoice_number ?? d.quote_number ?? "—"}</td>
                    <td>{d.amount_incl_tax !== null ? `${formatAmount(d.amount_incl_tax, d.currency ?? "EUR")} TTC` : d.amount_excl_tax !== null ? `${formatAmount(d.amount_excl_tax, d.currency ?? "EUR")} HT` : "—"}</td>
                    <td>{d.doc_type === "QUOTE" ? d.valid_until ?? "—" : d.due_date ?? "—"}</td>
                    <td className="muted">{formatDateTime(d.created_at, tz)}</td>
                    <td><ConfidenceBadge confidence={d.doc_confidence} reliable={settings.analysis.reliableThreshold} review={settings.analysis.reviewThreshold} /></td>
                    <td className="stack">
                      <span className={`badge ${DOC_STATUS[d.status]?.tone ?? ""}`}>{DOC_STATUS[d.status]?.label ?? d.status}</span>
                      {d.requires_human_review === 1 ? <span className="badge warn">À vérifier</span> : null}
                      {d.possible_duplicate === 1 ? <span className="badge danger">Doublon potentiel</span> : null}
                      {d.bank_details_change === 1 ? <span className="badge danger">⚠️ Changement RIB</span> : null}
                      {d.text_status === "no_text" ? <span className="badge">PDF sans texte</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
