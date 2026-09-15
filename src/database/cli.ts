import { getDb, closeDb } from "./connection";
import { migrationStatus } from "./migrate";

const cmd = process.argv[2] ?? "status";

if (cmd === "migrate") {
  const db = getDb(); // runMigrations est appelé à l'ouverture
  const status = migrationStatus(db);
  console.log("Migrations appliquées :");
  for (const s of status) console.log(`  ${s.applied ? "✅" : "⏳"} ${s.name}${s.appliedAt ? ` (${s.appliedAt})` : ""}`);
  closeDb();
} else if (cmd === "status") {
  const db = getDb();
  for (const s of migrationStatus(db)) console.log(`${s.applied ? "applied " : "pending "} ${s.name}`);
  closeDb();
} else {
  console.error(`Commande inconnue : ${cmd} (migrate | status)`);
  process.exit(1);
}
