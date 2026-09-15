import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { settingsSchema, rulesFileSchema, contactsFileSchema, companiesFileSchema, readConfig, writeConfig } from "@/lib/config";

const CONFIG_DIR = path.resolve(process.cwd(), "config");

describe("Fichiers de configuration d'exemple", () => {
  it("settings.example.json est valide", () => {
    expect(() => settingsSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "settings.example.json"), "utf8")))).not.toThrow();
  });
  it("rules.example.json est valide et sans secret", () => {
    const rules = rulesFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "rules.example.json"), "utf8")));
    expect(rules.rules.length).toBeGreaterThan(0);
    expect(rules.rules.some((r) => r.then.action === "require_approval")).toBe(true);
  });
  it("contacts.example.json et companies.example.json sont valides", () => {
    expect(() => contactsFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "contacts.example.json"), "utf8")))).not.toThrow();
    expect(() => companiesFileSchema.parse(JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "companies.example.json"), "utf8")))).not.toThrow();
  });
});

describe("Lecture / écriture de configuration", () => {
  it("crée un fichier par défaut, écrit et relit", () => {
    const s = readConfig("settings");
    expect(s.company.timezone).toBe("Europe/Paris");
    const written = writeConfig("settings", { ...s, company: { ...s.company, name: "Test SAS" } });
    expect(written.company.name).toBe("Test SAS");
    expect(readConfig("settings").company.name).toBe("Test SAS");
  });

  it("refuse toute clé ressemblant à un secret", () => {
    expect(() => writeConfig("contacts", { version: 1, contacts: [{ id: "a", name: "A", email: "a@b.fr", role: "x", internal: true, api_key: "sk-..." }] })).toThrow(/interdite/);
  });

  it("refuse une règle invalide", () => {
    expect(() => writeConfig("rules", { version: 1, rules: [{ id: "x", name: "x", when: {}, then: { action: "forward", to: "pas-un-email" } }] })).toThrow(/invalide/);
  });
});
