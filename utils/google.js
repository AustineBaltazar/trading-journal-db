const { OAuth2Client } = require("google-auth-library");

// "Continue with Google": the browser gets a signed ID token from Google's button,
// and we check its signature, audience and expiry against Google's public keys.
// No client secret is involved. Off when GOOGLE_CLIENT_ID is unset.
let client;

function googleEnabled() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

// { sub, email, name } for a valid token with a verified email, else null
async function verifyGoogleCredential(credential) {
  if (!googleEnabled() || typeof credential !== "string" || !credential || credential.length > 4096) {
    return null;
  }
  client ??= new OAuth2Client();
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p?.sub || !p.email || p.email_verified !== true) return null;
    const email = p.email.trim().toLowerCase();
    const name = (p.name || p.given_name || email.split("@")[0]).trim().slice(0, 60);
    return { sub: p.sub, email, name };
  } catch (err) {
    console.error("Google sign-in rejected:", err.message);
    return null;
  }
}

module.exports = { googleEnabled, verifyGoogleCredential };
