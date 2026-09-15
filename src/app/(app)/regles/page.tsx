import { RulesEditor } from "@/components/rules-editor";
import { getContacts, readConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function RulesPage() {
  const rules = readConfig("rules");
  const contacts = getContacts();
  return (
    <>
      <h1>Règles</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Les règles déterminent qui reçoit quoi (ex. facture Brink&apos;s → Magali) et quelles actions exigent une validation. Elles sont stockées dans <code>config/rules.json</code>. Les paiements et signatures exigent toujours une validation, quelles que soient les règles.
      </p>
      <RulesEditor initial={rules} contacts={contacts} />
    </>
  );
}
