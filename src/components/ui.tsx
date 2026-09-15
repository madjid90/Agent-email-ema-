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
  NEW: { label: "À analyser", tone: "primary" },
  ANALYZING: { label: "Analyse en cours", tone: "primary" },
  ANALYZED: { label: "Analysé", tone: "ok" },
  ANALYSIS_FAILED: { label: "Analyse échouée", tone: "danger" },
  ACTION_PROPOSED: { label: "Action proposée", tone: "warn" },
  PROCESSED: { label: "Traité", tone: "ok" },
  IGNORED: { label: "Ignoré", tone: "" },
  ERROR: { label: "Erreur", tone: "danger" },
  CONTEXT: { label: "Contexte", tone: "" },
  PENDING: { label: "En attente", tone: "warn" },
  EXPIRED: { label: "Expirée", tone: "" },
  MODIFIED: { label: "Modifiée", tone: "primary" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_LABEL[status] ?? { label: status, tone: "" };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

const CATEGORY_LABEL: Record<string, string> = {
  INVOICE: "Facture",
  QUOTE: "Devis",
  PAYMENT_REQUEST: "Demande de paiement",
  DEPOSIT_REQUEST: "Demande d'acompte",
  SUPPLIER_FOLLOWUP: "Relance fournisseur",
  ADMIN_REQUEST: "Administratif",
  TECHNICAL_REQUEST: "Technique",
  INFORMATION: "Information",
  URGENT: "Urgence",
  DOCUMENT_TO_SIGN: "À signer",
  FOLLOWUP_REQUIRED: "Suivi requis",
  OTHER: "Autre",
};
export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return <span className="badge">Non analysé</span>;
  return <span className="badge primary">{CATEGORY_LABEL[category] ?? category}</span>;
}

const URGENCY: Record<string, { tone: string; label: string }> = {
  LOW: { tone: "", label: "Faible" },
  NORMAL: { tone: "primary", label: "Normale" },
  HIGH: { tone: "warn", label: "Haute" },
  CRITICAL: { tone: "danger", label: "Critique" },
};
export function UrgencyBadge({ urgency }: { urgency: string | null }) {
  if (!urgency) return null;
  const u = URGENCY[urgency] ?? { tone: "", label: urgency };
  return <span className={`badge ${u.tone}`}>{u.label}</span>;
}

const ACTION_LABEL: Record<string, string> = {
  reply: "Répondre",
  forward: "Transférer",
  payment_request: "Demande de règlement",
  deposit_request: "Demande d'acompte",
  sign_document: "Signer le document",
  schedule_followup: "Programmer une relance",
  archive: "Archiver",
  none: "Aucune",
};
export function actionLabel(action: string | null): string {
  if (!action) return "—";
  return ACTION_LABEL[action] ?? action;
}

export function ConfidenceBadge({ confidence, reliable = 0.85, review = 0.6 }: { confidence: number | null; reliable?: number; review?: number }) {
  if (confidence === null) return <span className="badge">—</span>;
  const pct = `${Math.round(confidence * 100)} %`;
  if (confidence >= reliable) return <span className="badge ok">{pct}</span>;
  if (confidence >= review) return <span className="badge warn" title="Confiance moyenne : vérifier">{pct} ⚠</span>;
  return <span className="badge danger" title="Confiance faible : validation humaine">{pct}</span>;
}

const DOC_TYPE: Record<string, { label: string; tone: string }> = {
  INVOICE: { label: "Facture", tone: "primary" },
  CREDIT_NOTE: { label: "Avoir", tone: "primary" },
  QUOTE: { label: "Devis", tone: "primary" },
  PAYMENT_PROOF: { label: "Justificatif de paiement", tone: "" },
  BANK_DETAILS: { label: "RIB / coordonnées bancaires", tone: "warn" },
  PURCHASE_ORDER: { label: "Bon de commande", tone: "" },
  CONTRACT: { label: "Contrat", tone: "" },
  OTHER: { label: "Autre", tone: "" },
  UNKNOWN: { label: "Indéterminé", tone: "" },
};
export function DocTypeBadge({ type }: { type: string | null }) {
  if (!type) return <span className="badge">Non analysé</span>;
  const t = DOC_TYPE[type] ?? { label: type, tone: "" };
  return <span className={`badge ${t.tone}`}>{t.label}</span>;
}
