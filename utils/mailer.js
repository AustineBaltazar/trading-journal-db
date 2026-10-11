const nodemailer = require("nodemailer");

// Gmail with an app password by default; SMTP_HOST/PORT/SECURE point it elsewhere
// (a local test inbox, or Resend once there's a domain). Without SMTP_USER and no
// SMTP_HOST, emails are only logged.
let transport;
function getTransport() {
  if (transport !== undefined) return transport;
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const configured = Boolean(process.env.SMTP_USER) || Boolean(process.env.SMTP_HOST);
  transport = configured
    ? nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT || 465),
        secure: (process.env.SMTP_SECURE || "true") !== "false",
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : null;
  return transport;
}

const from = () => process.env.MAIL_FROM || `MNQ Journal <${process.env.SMTP_USER || "no-reply@localhost"}>`;

// Reserved test domains never get mail (the demo account, test sign-ups)
const RESERVED = /@(?:[^@]+\.)?(example\.(com|org|net)|[^@]+\.(test|invalid|example|localhost))$/i;

// Sends without making the caller wait, so every answer takes the same time
// whether or not an email went out. Failures are logged, never shown to the visitor.
function sendMail({ to, subject, text, html }) {
  if (RESERVED.test(to)) return Promise.resolve(false);
  const t = getTransport();
  if (!t) {
    console.log(`[mail not configured] to=${to} subject="${subject}"\n${text}`);
    return Promise.resolve(false);
  }
  return t
    .sendMail({ from: from(), to, subject, text, html })
    .then(() => true)
    .catch((err) => {
      console.error("Email failed:", err.message);
      return false;
    });
}

module.exports = { sendMail, RESERVED };
