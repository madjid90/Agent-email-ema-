import { companySchema, type Company } from "@/lib/config";

/** Société de test avec toutes les valeurs par défaut du schéma. */
export function makeCompany(overrides: Partial<Company> & { id: string; name: string }): Company {
  return companySchema.parse({ signatory: { name: "M", title: "" }, ...overrides });
}
