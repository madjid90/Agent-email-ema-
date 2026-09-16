/**
 * Chiffrement/déchiffrement des sauvegardes EMA (phase 8A).
 * AES-256-GCM, clé dérivée par scrypt depuis BACKUP_ENCRYPTION_PASSWORD.
 * Aucune dépendance externe, aucun secret journalisé.
 *
 * Usage : node scripts/backup-crypto.cjs encrypt|decrypt <entrée> <sortie>
 * Le mot de passe est lu dans la variable d'environnement BACKUP_ENCRYPTION_PASSWORD.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");

const MAGIC = Buffer.from("EMABK1");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function deriveKey(password, salt) {
  return crypto.scryptSync(Buffer.from(password, "utf8"), salt, KEY_BYTES, { N: 16384, r: 8, p: 1 });
}

function encrypt(input, output, password) {
  const plain = fs.readFileSync(input);
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  fs.writeFileSync(output, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]), { mode: 0o600 });
}

function decrypt(input, output, password) {
  const raw = fs.readFileSync(input);
  if (raw.subarray(0, MAGIC.length).compare(MAGIC) !== 0) throw new Error("Archive chiffrée invalide (en-tête inattendu)");
  let offset = MAGIC.length;
  const salt = raw.subarray(offset, (offset += SALT_BYTES));
  const iv = raw.subarray(offset, (offset += IV_BYTES));
  const tag = raw.subarray(offset, (offset += TAG_BYTES));
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(raw.subarray(offset)), decipher.final()]);
  fs.writeFileSync(output, plain, { mode: 0o600 });
}

function main() {
  const [mode, input, output] = process.argv.slice(2);
  const password = process.env.BACKUP_ENCRYPTION_PASSWORD ?? "";
  if (!mode || !input || !output) {
    console.error("Usage : node scripts/backup-crypto.cjs encrypt|decrypt <entrée> <sortie>");
    process.exit(2);
  }
  if (password.length < 12) {
    console.error("BACKUP_ENCRYPTION_PASSWORD absent ou trop court (12 caractères minimum).");
    process.exit(3);
  }
  try {
    if (mode === "encrypt") encrypt(input, output, password);
    else if (mode === "decrypt") decrypt(input, output, password);
    else throw new Error(`Mode inconnu : ${mode}`);
  } catch (err) {
    // Jamais le mot de passe, jamais le contenu : seulement la nature de l'échec.
    console.error(mode === "decrypt" ? "Déchiffrement impossible : mot de passe incorrect ou archive altérée." : `Chiffrement impossible : ${err.message}`);
    process.exit(1);
  }
}

main();
