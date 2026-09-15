import type { ReactNode } from "react";

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title || actions ? (
        <div className="row between" style={{ marginBottom: "0.75rem" }}>
          {title ? <h3 style={{ margin: 0 }}>{title}</h3> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "danger" | "warn" | "ok" | "primary" }) {
  return (
    <div className="card stat">
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const RISK_TONE: Record<string, string> = { LOW: "ok", MEDIUM: "primary", HIGH: "warn", CRITICAL: "danger" };
export function RiskBadge({ level }: { level: string }) {
  return <span className={`badge ${RISK_TONE[level] ?? ""}`}>{level}</span>;
}

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  PROPOSED: { label: "Proposée", tone: "" },
  WAITING_APPROVAL: { label: "À valider", tone: "warn" },
  APPROVED: { label: "Validée", tone: "primary" },
  EXECUTING: { label: "En cours", tone: "primary" },
  COMPLETED: { label: "Terminée", tone: "ok" },
  REJECTED: { label: "Refusée", tone: "danger" },
  FAILED: { label: "Échec", tone: "danger" },
  SCHEDULED: { label: "Programmée", tone: "primary" },
  CHECKING: { label: "Vérification", tone: "primary" },
  CANCELLED: { label: "Annulée", tone: "" },
  NEW: { label: "Nouveau", tone: "primary" },
  ANALYZED: { label: "Analysé", tone: "" },
  ACTION_PROPOSED: { label: "Action proposée", tone: "warn" },
  PROCESSED: { label: "Traité", tone: "ok" },
  IGNORED: { label: "Ignoré", tone: "" },
  ERROR: { label: "Erreur", tone: "danger" },
  CONTEXT: { label: "Contexte", tone: "" },
  PENDING: { label: "En attente", tone: "warn" },
  EXPIRED: { label: "Expirée", tone: "" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "" };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

const CATEGORY_LABEL: Record<string, string> = {
  invoice: "Facture",
  quote: "Devis",
  payment: "Paiement",
  deposit: "Acompte",
  reminder: "Relance reçue",
  administrative: "Administratif",
  technical: "Technique",
  information: "Information",
  urgent: "Urgence",
  document_to_sign: "À signer",
  to_forward: "À transférer",
  needs_reply: "À répondre",
  other: "Autre",
};
export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return <span className="badge">Non analysé</span>;
  return <span className="badge primary">{CATEGORY_LABEL[category] ?? category}</span>;
}

const URGENCY_TONE: Record<string, string> = { low: "", medium: "primary", high: "warn", critical: "danger" };
export function UrgencyBadge({ urgency }: { urgency: string | null }) {
  if (!urgency) return null;
  return <span className={`badge ${URGENCY_TONE[urgency] ?? ""}`}>{urgency}</span>;
}
