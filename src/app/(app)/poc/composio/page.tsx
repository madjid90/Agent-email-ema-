import { notFound } from "next/navigation";
import { ComposioPocPanel } from "@/components/composio-poc-panel";
import { getPocState, isComposioPocEnabled } from "@/integrations/composio/outlook-poc";
import { runComposioPreflight } from "@/integrations/composio/preflight";
import { requireSessionUser } from "@/security/auth";

export const dynamic = "force-dynamic";

/** Page POC « Outlook via Composio » : visible uniquement si COMPOSIO_POC_ENABLED=true et pour un utilisateur authentifié. */
export default async function ComposioPocPage({ searchParams }: { searchParams: Promise<{ error?: string; returned?: string }> }) {
  if (!isComposioPocEnabled()) notFound();
  const { error, returned } = await searchParams;
  const user = await requireSessionUser();
  const state = getPocState(user);
  const preflight = runComposioPreflight();
  return (
    <>
      <h1>POC — Outlook via Composio</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Test technique en lecture seule, isolé de l&apos;intégration Microsoft Graph existante (qui reste utilisée par EMA). Compte : <strong>{user.email}</strong>. Mode de retour OAuth : <strong>{state.callbackMode === "verified" ? "vérifié (Callback Identity Verification)" : "local (non production-ready)"}</strong>.
      </p>
      <ComposioPocPanel initial={state} preflight={preflight} returned={returned === "1"} notice={error ? { tone: "danger", text: `Connexion refusée : ${error}` } : returned ? { tone: "info", text: "Retour du parcours OAuth : statut relu chez Composio." } : null} />
    </>
  );
}
