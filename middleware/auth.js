const pool = require("../db");
const { COOKIE_NAME, findSession } = require("../utils/sessions");

async function requireAuth(req, res, next) {
  const sessionToken = req.cookies?.[COOKIE_NAME];
  if (sessionToken) {
    try {
      const session = await findSession(pool, sessionToken);
      if (session) {
        req.userId = session.user_id;
        req.sessionId = session.id;
        return next();
      }
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Something went wrong." });
    }
  }
  return res.status(401).json({ error: "Please log in." });
}

module.exports = requireAuth;
