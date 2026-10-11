const pool = require("../db");
const { COOKIE_NAME, findSession } = require("../utils/sessions");
const { isDemo, isAdmin, DEMO_READ_ONLY } = require("../utils/account");

// Writes the demo account may still make
const DEMO_ALLOWED = new Set(["/feedback"]);

async function requireAuth(req, res, next) {
  const sessionToken = req.cookies?.[COOKIE_NAME];
  if (sessionToken) {
    try {
      const session = await findSession(pool, sessionToken);
      if (session) {
        req.userId = session.user_id;
        req.sessionId = session.id;
        req.isDemo = isDemo(session.email);
        req.isAdmin = isAdmin(session.email);
        if (req.isDemo && !["GET", "HEAD"].includes(req.method) && !DEMO_ALLOWED.has(req.path)) {
          return res.status(403).json(DEMO_READ_ONLY);
        }
        return next();
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Something went wrong." });
    }
  }
  return res.status(401).json({ error: "Please log in." });
}

// Admin-only routes answer "not found" to everyone else, so they don't even show they exist
function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(404).json({ error: "Not found." });
  next();
}

module.exports = requireAuth;
module.exports.requireAdmin = requireAdmin;
