/**
 * Copie cohérente de la base SQLite via better-sqlite3 (API backup), sans
 * dépendre du binaire sqlite3. Vérifie l'intégrité de la copie et renvoie les
 * compteurs de lignes en JSON. Usage : node scripts/db-snapshot.cjs <src> <dest>
 */
const path = require("node:path");
const Database = require(path.resolve(__dirname, "..", "node_modules", "better-sqlite3"));

async function main() {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("Usage : node scripts/db-snapshot.cjs <source.db> <destination.db>");
    process.exit(2);
  }
  const db = new Database(src, { readonly: true, fileMustExist: true });
  await db.backup(dest);
  db.close();

  const copy = new Database(dest, { readonly: true });
  const integrity = copy.prepare("PRAGMA integrity_check").get().integrity_check;
  const counts = {};
  for (const table of ["emails", "documents", "actions", "approvals", "scheduled_followups", "history", "chat_messages"]) {
    try {
      counts[table] = copy.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } catch {
      counts[table] = null;
    }
  }
  copy.close();
  if (integrity !== "ok") {
    console.error(`Intégrité de la copie : ${integrity}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ integrity, counts }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
