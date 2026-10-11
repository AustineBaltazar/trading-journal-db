// Screenshot storage per account during the beta (trade + journal images together)
const STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;

async function usedStorageBytes(db, userId) {
  const result = await db.query(
    `SELECT
       coalesce((SELECT sum(i.size_bytes) FROM trade_images i JOIN trades t ON t.id = i.trade_id WHERE t.user_id = $1), 0)
     + coalesce((SELECT sum(i.size_bytes) FROM journal_images i JOIN journal_entries e ON e.id = i.entry_id WHERE e.user_id = $1), 0)
       AS used`,
    [userId],
  );
  return Number(result.rows[0]?.used ?? 0);
}

// An error message when adding `size` bytes would go over the limit, else null
async function storageProblem(db, userId, size) {
  const used = await usedStorageBytes(db, userId);
  if (used + Number(size) <= STORAGE_LIMIT_BYTES) return null;
  return "Your screenshots have reached the 200 MB beta limit. Delete some to add more.";
}

// The demo account anyone can log into is read-only, so visitors can't change or delete it
const demoEmail = () => (process.env.DEMO_EMAIL || "giyotest@example.com").toLowerCase();
const isDemo = (email) => typeof email === "string" && email.toLowerCase() === demoEmail();
const DEMO_READ_ONLY = {
  error: "This is the demo account, so it's read-only. Sign up free to keep your own journal.",
  demo: true,
};

// "Chrome on Windows · 203.0.113.x": enough to recognise a device, without the full address
function maskIp(ip) {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.replace(/\.\d+$/, ".x");
  return ip.split(":").slice(0, 3).join(":") + ":…";
}

// One CSV field
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  // Cells starting like a formula are prefixed so spreadsheets don't run them
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(columns, rows) {
  return [columns.join(","), ...rows.map((row) => columns.map((c) => csvCell(row[c])).join(","))].join("\r\n");
}

module.exports = { STORAGE_LIMIT_BYTES, usedStorageBytes, storageProblem, isDemo, DEMO_READ_ONLY, maskIp, toCsv, csvCell };
