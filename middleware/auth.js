require("dotenv").config();
const jwt = require("jsonwebtoken");
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

  // Bearer tokens from before the cookie switch, accepted for one release
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET, { algorithms: ["HS256"] });
      req.userId = decoded.id;
      return next();
    } catch {
      // falls through to 401
    }
  }

  return res.status(401).json({ error: "Please log in." });
}

module.exports = requireAuth;
