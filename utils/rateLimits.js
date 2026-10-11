const { rateLimit } = require("express-rate-limit");

// Per-IP limits. They only count requests that came through Nginx (which sets
// X-Forwarded-For); without it every visitor would share Nginx's address.
function perIp(windowMinutes, limit, error) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => !req.headers["x-forwarded-for"],
    message: { error },
  });
}

const loginLimiter = perIp(15, 30, "Too many login attempts from your network. Please wait a few minutes.");
const registerLimiter = perIp(60, 5, "Too many sign-ups from your network. Please try again later.");

module.exports = { perIp, loginLimiter, registerLimiter };
