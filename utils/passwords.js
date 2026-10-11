const crypto = require("crypto");
const argon2 = require("@node-rs/argon2");
const bcrypt = require("bcrypt");

// OWASP's recommended Argon2id settings (19 MiB, 2 passes)
const ARGON2_OPTIONS = { algorithm: argon2.Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

// Accounts made before Argon2 still have bcrypt hashes; those pass with needsRehash
// so the login can upgrade them.
async function verifyPassword(storedHash, password) {
  // Google-only accounts have no password: take the usual time, then fail
  if (!storedHash) {
    await burnPasswordCheck(password);
    return { ok: false, needsRehash: false };
  }
  if (storedHash.startsWith("$2")) {
    return { ok: await bcrypt.compare(password, storedHash), needsRehash: true };
  }
  try {
    return { ok: await argon2.verify(storedHash, password), needsRehash: false };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

// Used when the email has no account, so a wrong email takes as long as a wrong password
let dummyHash;
async function burnPasswordCheck(password) {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  await argon2.verify(await dummyHash, password).catch(() => false);
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function isEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// The rules a new password must pass, apart from the leak check
function passwordProblem(password, email) {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  const localPart = email.split("@")[0];
  if (lower === email || (localPart.length >= 4 && lower === localPart)) {
    return "Password can't be your email.";
  }
  return null;
}

// Have I Been Pwned range check: only the first 5 characters of the SHA-1 leave the server.
// If the service can't be reached the password is allowed, so sign-up never depends on it.
async function isLeakedPassword(password, fetchImpl = fetch) {
  const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const body = await response.text();
    return body.split("\n").some((line) => {
      const [hashSuffix, count] = line.trim().split(":");
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch (err) {
    console.error("Leaked-password check unavailable:", err.message);
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  normalizeEmail,
  isEmail,
  passwordProblem,
  isLeakedPassword,
  MIN_LENGTH,
};
