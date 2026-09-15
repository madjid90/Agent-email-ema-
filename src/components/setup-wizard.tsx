"use client";

import { useState } from "react";
import Link from "next/link";
import type { CompaniesFile, Contact, RulesFile, Settings } from "@/lib/config";
import { SettingsForm } from "./settings-form";
import { RulesEditor } from "./rules-editor";
import { CompaniesEditor } from "./companies-editor";

const STEPS = [
  { id: "company", label: "1. Entreprise" },
  { id: "outlook", label: "2. Outlook" },
  { id: "claude", label: "3. Claude" },
  { id: "whatsapp", label: "4. WhatsApp" },
  { id: "rules", label: "5. Règles" },
  { id: "companies", label: "6. Sociétés" },
  { id: "assets", label: "7. Signatures / tampons" },
  { id: "test", label: "8. Test" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

interface ComponentStatus { component: string; ok: boolean; configured: boolean; message: string }

interface Props {
  initialStep: string;
  settings: Settings;
  rules: RulesFile;
  companies: CompaniesFile;
  contacts: Contact[];
  integrations: { anthropic: boolean; microsoft: boolean; whatsapp: boolean; appSecret: boolean; appPassword: boolean };
  outlook: { configured: boolean; connected: boolean; accountEmail: string | null; scopes: string[] };
  whatsapp: { configured: boolean; recipientConfigured: boolean };
  model: string;
  completedSteps: string[];
}

const LABELS: Record<string, string> = { claude: "Claude", outlook: "Outlook", whatsapp: "WhatsApp", sqlite: "SQLite", pdf: "PDF / stockage", worker: "Worker" };

export function SetupWizard(p: Props) {
  const [step, setStep] = useState<StepId>(STEPS.some((s) => s.id === p.initialStep) ? (p.initialStep as StepId) : "company");
  const [done, setDone] = useState<Set<string>>(new Set(p.completedSteps));
  const [tests, setTests] = useState<Record<string, ComponentStatus | "loading">>({});
  const idx = STEPS.findIndex((s) => s.id === step);

  async function markDone(id: StepId) {
    await fetch("/api/setup", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ completedStep: id }) });
    setDone(new Set([...done, id]));
  }
  function next() {
    const n = STEPS[idx + 1];
    if (n) setStep(n.id);
  }
  async function runTest(component: string) {
    setTests((t) => ({ ...t, [component]: "loading" }));
    const res = await fetch("/api/setup/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ component }) });
    const json = (await res.json()) as { ok: boolean; data?: ComponentStatus | ComponentStatus[]; error?: { message: string } };
    if (!json.ok || !json.data) {
      setTests((t) => ({ ...t, [component]: { component, ok: false, configured: false, message: json.error?.message ?? "Erreur" } }));
      return;
    }
    if (Array.isArray(json.data)) setTests(Object.fromEntries(json.data.map((c) => [c.component, c])));
    else setTests((t) => ({ ...t, [component]: json.data as ComponentStatus }));
  }

  const testRow = (component: string) => {
    const t = tests[component];
    return (
      <tr key={component}>
        <td>{LABELS[component] ?? component}</td>
        <td>{t === "loading" ? <span className="badge">…</span> : t ? <span className={`badge ${t.ok ? "ok" : "warn"}`}>{t.ok ? "OK" : "KO"}</span> : <span className="badge">non testé</span>}</td>
        <td className="muted">{t && t !== "loading" ? t.message : ""}</td>
        <td><button className="btn small" onClick={() => void runTest(component)}>Tester</button></td>
      </tr>
    );
  };

  const allOk = ["claude", "outlook", "whatsapp", "sqlite", "pdf", "worker"].every((c) => { const t = tests[c]; return t && t !== "loading" && t.ok; });
  const navButtons = (canContinue = true) => (
    <div className="row" style={{ marginTop: "1rem" }}>
      {idx > 0 ? <button className="btn" onClick={() => setStep(STEPS[idx - 1]!.id)}>Précédent</button> : null}
      {idx < STEPS.length - 1 ? <button className="btn primary" disabled={!canContinue} onClick={() => { void markDone(step); next(); }}>Continuer</button> : null}
    </div>
  );

  return (
    <>
      <div className="steps">
        {STEPS.map((s) => (
          <button key={s.id} className={`step${s.id === step ? " active" : done.has(s.id) ? " done" : ""}`} onClick={() => setStep(s.id)} style={{ cursor: "pointer" }}>{s.label}</button>
        ))}
      </div>

      {step === "company" ? (<><SettingsForm initial={p.settings} compact onSaved={() => void markDone("company")} />{navButtons()}</>) : null}

      {step === "outlook" ? (
        <div className="card">
          <h3>Connexion Outlook (Microsoft Graph)</h3>
          {!p.integrations.microsoft ? (
            <div className="alert warn">Renseignez <code>MICROSOFT_CLIENT_ID</code>, <code>MICROSOFT_CLIENT_SECRET</code>, <code>MICROSOFT_TENANT_ID</code> et <code>MICROSOFT_REDIRECT_URI</code> dans <code>.env</code>, puis redémarrez EMA.</div>
          ) : null}
          {p.outlook.connected ? (
            <div className="alert ok">
              <strong>Outlook connecté</strong><br />Adresse : {p.outlook.accountEmail ?? "—"}<br />Permissions : {p.outlook.scopes.join(", ") || "—"}
            </div>
          ) : (
            <p className="muted">EMA ne demande jamais votre mot de passe : la connexion passe par OAuth Microsoft. Le bouton ci-dessous sera actif en phase 1.</p>
          )}
          <a className="btn primary" href="/api/outlook/connect" aria-disabled={!p.integrations.microsoft} onClick={(e) => { if (!p.integrations.microsoft) e.preventDefault(); }}>Connecter Outlook</a>
          {navButtons()}
        </div>
      ) : null}

      {step === "claude" ? (
        <div className="card">
          <h3>Claude (Anthropic)</h3>
          <p>La clé API se définit dans <code>.env</code> (<code>ANTHROPIC_API_KEY</code>), jamais depuis l&apos;interface. Modèle configuré : <code>{p.model}</code>.</p>
          <div className={`alert ${p.integrations.anthropic ? "ok" : "warn"}`}>{p.integrations.anthropic ? "Clé API détectée." : "ANTHROPIC_API_KEY absente."}</div>
          <table><tbody>{testRow("claude")}</tbody></table>
          {navButtons()}
        </div>
      ) : null}

      {step === "whatsapp" ? (
        <div className="card">
          <h3>WhatsApp Business Cloud API</h3>
          <p>Variables requises dans <code>.env</code> : <code>WHATSAPP_ACCESS_TOKEN</code>, <code>WHATSAPP_PHONE_NUMBER_ID</code>, <code>WHATSAPP_VERIFY_TOKEN</code>, <code>WHATSAPP_RECIPIENT_NUMBER</code>.</p>
          <div className={`alert ${p.whatsapp.configured && p.whatsapp.recipientConfigured ? "ok" : "warn"}`}>{p.whatsapp.configured ? (p.whatsapp.recipientConfigured ? "Configuration détectée." : "Numéro destinataire manquant.") : "Configuration absente."}</div>
          <table><tbody>{testRow("whatsapp")}</tbody></table>
          {navButtons()}
        </div>
      ) : null}

      {step === "rules" ? (<><RulesEditor initial={p.rules} contacts={p.contacts} />{navButtons()}</>) : null}
      {step === "companies" ? (<><CompaniesEditor initial={p.companies} />{navButtons()}</>) : null}

      {step === "assets" ? (
        <div className="card">
          <h3>Signatures et tampons</h3>
          <p className="muted">Pour chaque société, téléversez la signature et le tampon (PNG, fond transparent, 2 Mo max) depuis la page <Link href="/societes">Sociétés</Link> ou l&apos;étape précédente. Les fichiers sont stockés dans <code>private/signatures</code> et <code>private/stamps</code> et ne sont jamais transmis à Claude.</p>
          <ul>
            {p.companies.companies.map((c) => (
              <li key={c.id}>{c.name} — signature : <span className={`badge ${c.signaturePath ? "ok" : "warn"}`}>{c.signaturePath ? "OK" : "manquante"}</span> · tampon : <span className={`badge ${c.stampPath ? "ok" : "warn"}`}>{c.stampPath ? "OK" : "manquant"}</span></li>
            ))}
          </ul>
          {navButtons()}
        </div>
      ) : null}

      {step === "test" ? (
        <div className="card">
          <h3>Test de l&apos;installation</h3>
          <table>
            <thead><tr><th>Composant</th><th>État</th><th>Détail</th><th></th></tr></thead>
            <tbody>{["claude", "outlook", "whatsapp", "sqlite", "pdf", "worker"].map(testRow)}</tbody>
          </table>
          <div className="row" style={{ marginTop: "1rem" }}>
            <button className="btn primary" onClick={() => void runTest("all")}>Tout tester</button>
            <button className="btn" onClick={() => setStep("assets")}>Précédent</button>
          </div>
          {allOk ? <div className="alert ok" style={{ marginTop: "1rem" }}><strong>EMA est prêt.</strong> <Link href="/">Aller à la page Aujourd&apos;hui</Link></div> : null}
        </div>
      ) : null}
    </>
  );
}
