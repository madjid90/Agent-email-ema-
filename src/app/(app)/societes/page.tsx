import { CompaniesEditor } from "@/components/companies-editor";
import { readConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function CompaniesPage() {
  const companies = readConfig("companies");
  return (
    <>
      <h1>Sociétés</h1>
      <p className="muted" style={{ marginBottom: "1rem" }}>
        Chaque société signataire dispose de son signataire, de sa signature et de son tampon (fichiers PNG stockés dans <code>private/</code>, jamais transmis à Claude).
      </p>
      <CompaniesEditor initial={companies} />
    </>
  );
}
