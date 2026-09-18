import { ConnectionsPanel } from "@/components/connections-panel";
import { getOutlookStatus } from "@/integrations/microsoft";
import { getWhatsappActivation } from "@/integrations/whatsapp/activation";
import { requireSessionUser } from "@/security/auth";
import { isComposioPocEnabled } from "@/integrations/composio/outlook-poc";

export const dynamic = "force-dynamic";

/** Paramètres → Connexions : Outlook et WhatsApp du compte connecté. */
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const { error, connected } = await searchParams;
  const user = await requireSessionUser();
  const outlook = getOutlookStatus(undefined, user.id);
  const whatsapp = getWhatsappActivation(user);
  const notice = error ? { tone: "danger" as const, text: `Connexion Outlook refusée : ${error}` } : connected ? { tone: "ok" as const, text: "Outlook connecté ✅ — EMA va synchroniser votre boîte." } : null;
  return (
    <>
      <h1>Connexions</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Compte : <strong>{user.name ?? user.email}</strong> ({user.email})
      </p>
      <ConnectionsPanel
        outlook={{ configured: outlook.configured, connected: outlook.connected, status: outlook.status, accountEmail: outlook.accountEmail, lastSyncAt: outlook.lastSyncAt, lastSyncError: outlook.lastSyncError }}
        whatsapp={{ configured: whatsapp.configured, businessNumberDisplay: whatsapp.businessNumberDisplay, openLink: whatsapp.openLink, status: whatsapp.status, phoneDisplay: whatsapp.phoneDisplay, activationText: whatsapp.activationText }}
        notice={notice}
      />
      {isComposioPocEnabled() ? (
        <section className="card" style={{ marginTop: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>Outlook via Composio (POC)</h2>
          <p className="muted">Test technique en lecture seule, indépendant de la connexion Outlook ci-dessus.</p>
          <a className="btn small" href="/poc/composio">Ouvrir le POC</a>
        </section>
      ) : null}
    </>
  );
}
