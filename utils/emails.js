// The emails the app sends: plain text plus a simple HTML version
const appUrl = () => (process.env.APP_URL || "http://localhost:4200").replace(/\/$/, "");

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout({ heading, lines, button, footer }) {
  const html = `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
  <p style="font-size:13px;color:#64748b;margin:0 0 16px"><b style="color:#0f172a">MNQ JOURNAL</b></p>
  <h1 style="font-size:20px;margin:0 0 12px">${escape(heading)}</h1>
  ${lines.map((l) => `<p style="font-size:14px;line-height:1.5;color:#334155;margin:0 0 12px">${escape(l)}</p>`).join("")}
  ${button ? `<p style="margin:20px 0"><a href="${escape(button.url)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">${escape(button.label)}</a></p>
  <p style="font-size:12px;color:#64748b;margin:0 0 12px">Or open this link: ${escape(button.url)}</p>` : ""}
  ${footer.map((f) => `<p style="font-size:12px;color:#64748b;margin:0 0 6px">${escape(f)}</p>`).join("")}
</div>`;
  const text = [heading, "", ...lines, ...(button ? ["", `${button.label}: ${button.url}`] : []), "", ...footer].join("\n");
  return { html, text };
}

const when = (date = new Date()) =>
  date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

function verifyEmail(name, token) {
  return {
    subject: "Confirm your email",
    ...layout({
      heading: "Confirm your email",
      lines: [`Hi ${name}, tap the button to finish creating your trading journal.`],
      button: { label: "Confirm email", url: `${appUrl()}/verify-email?token=${token}` },
      footer: ["This link works once and expires in 30 minutes.", "Didn't sign up? Ignore this email. No account is created."],
    }),
  };
}

function resetPassword(name, token) {
  return {
    subject: "Reset your password",
    ...layout({
      heading: "Reset your password",
      lines: [`Hi ${name}, someone (hopefully you) asked to reset your MNQ Journal password.`],
      button: { label: "Choose a new password", url: `${appUrl()}/reset-password?token=${token}` },
      footer: ["This link works once and expires in 30 minutes.", "Didn't ask for this? Ignore this email. Your password stays the same."],
    }),
  };
}

function signupAttempt(name) {
  return {
    subject: "Someone tried to sign up with your email",
    ...layout({
      heading: "You already have an account",
      lines: [
        `Hi ${name}, someone just tried to create a new MNQ Journal account with this email address. You already have one, so nothing was changed.`,
        "If it was you, log in instead. If you forgot your password, you can reset it.",
      ],
      button: { label: "Reset password", url: `${appUrl()}/forgot-password` },
      footer: ["If it wasn't you, you can ignore this email."],
    }),
  };
}

function newLogin(name, device, date) {
  return {
    subject: "New login to your journal",
    ...layout({
      heading: "New login to your journal",
      lines: [`Hi ${name}, your account was just used to log in from ${device}, ${when(date)}.`],
      button: { label: "Not you? Reset your password", url: `${appUrl()}/forgot-password` },
      footer: ["Resetting your password logs every other device out."],
    }),
  };
}

function passwordChanged(name, date) {
  return {
    subject: "Your password was changed",
    ...layout({
      heading: "Your password was changed",
      lines: [`Hi ${name}, the password for your MNQ Journal account was changed on ${when(date)}.`],
      button: { label: "Not you? Reset it now", url: `${appUrl()}/forgot-password` },
      footer: ["If you made this change, you don't need to do anything."],
    }),
  };
}

function accountLocked(name, minutes) {
  return {
    subject: "Your account was locked for a few minutes",
    ...layout({
      heading: "Too many wrong passwords",
      lines: [
        `Hi ${name}, someone typed the wrong password for your account several times, so logging in is paused for ${minutes} minutes.`,
        "If it was you and you've forgotten it, reset your password. If it wasn't you, your account is safe, but choosing a new, unique password is a good idea.",
      ],
      button: { label: "Reset password", url: `${appUrl()}/forgot-password` },
      footer: ["Resetting your password ends the lock straight away."],
    }),
  };
}

// "Chrome on Windows" from a user-agent string
function describeDevice(userAgent = "") {
  const ua = userAgent || "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "a browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "an unknown device";
  return `${browser} on ${os}`;
}

module.exports = { verifyEmail, resetPassword, signupAttempt, newLogin, passwordChanged, accountLocked, describeDevice, escape };
