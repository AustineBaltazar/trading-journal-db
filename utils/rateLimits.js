const { rateLimit } = require("express-rate-limit");

// Per-IP limits. They only count requests that came through Nginx (which sets
// X-Forwarded-For); without it every visitor would share Nginx's address.
function perIp(windowMinutes, limit, error, options = {}) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (req) => !req.headers["x-forwarded-for"],
    message: { error },
    ...options,
  });
}

// Every login try counts: failed passwords are what this limits
const loginLimiter = perIp(15, 30, "Too many login attempts from your network. Please wait a few minutes.");
// Only accounts actually created count, so typos and a failed human check don't lock
// out a whole household or office; Nginx already slows repeated tries
const registerLimiter = perIp(60, 10, "Too many new accounts from your network. Please try again later.", {
  skipFailedRequests: true,
});

// Forgot password and "resend the link": each sends an email
const emailLimiter = perIp(60, 10, "Too many email requests from your network. Please try again later.");

module.exports = { perIp, loginLimiter, registerLimiter, emailLimiter };
