import fs from "node:fs";
import path from "node:path";

/**
 * Chargement des prompts depuis le dépôt (fichiers .md).
 * Les prompts sont les seules instructions système : jamais de contenu externe ici.
 */
const PROMPTS_DIR = path.resolve(process.cwd(), "src/agent/prompts");
const SYSTEM_PROMPT_PATH = path.resolve(process.cwd(), "src/agent/ema.md");

const cache = new Map<string, string>();

function read(file: string): string {
  const cached = cache.get(file);
  if (cached) return cached;
  const content = fs.readFileSync(file, "utf8");
  cache.set(file, content);
  return content;
}

export function getSystemPrompt(): string {
  return read(SYSTEM_PROMPT_PATH);
}

export type PromptName = "analyze-email" | "followup" | "chat";

export function getPrompt(name: PromptName): string {
  return read(path.join(PROMPTS_DIR, `${name}.md`));
}
