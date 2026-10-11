// Cloudflare Turnstile ("are you human") check. Without TURNSTILE_SECRET it's switched off,
// which is how local dev and the tests run.
function turnstileEnabled() {
  return Boolean(process.env.TURNSTILE_SECRET);
}

async function verifyTurnstile(token, ip, fetchImpl = fetch) {
  if (!turnstileEnabled()) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    return result.success === true;
  } catch (err) {
    console.error("Turnstile check failed:", err.message);
    return false;
  }
}

module.exports = { turnstileEnabled, verifyTurnstile };
