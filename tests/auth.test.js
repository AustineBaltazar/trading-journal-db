const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
const { sendMail } = require("../utils/mailer");
const bcrypt = require("bcrypt");
const pool = require("../db");
const app = require("../app");
const {
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isEmail,
  passwordProblem,
  isLeakedPassword,
} = require("../utils/passwords");
const { lockMinutes, loginState } = require("../utils/loginGuard");
const { verifyTurnstile } = require("../utils/turnstile");
const { cookieOptions, hashToken } = require("../utils/sessions");

afterEach(() => {
  jest.restoreAllMocks();
  sendMail.mockClear();
  delete process.env.TURNSTILE_SECRET;
});

// Answers pool.query by matching the SQL; records every call
function fakeDb(handlers) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, answer] of handlers) {
      if (pattern.test(sql)) return typeof answer === "function" ? answer(params) : answer;
    }
    return { rows: [] };
  });
  jest.spyOn(pool, "query").mockImplementation(query);
  jest.spyOn(pool, "connect").mockResolvedValue({ query, release: () => {} });
  return calls;
}

const fetchReturning = (text, ok = true) => jest.fn(async () => ({ ok, text: async () => text, json: async () => JSON.parse(text) }));

describe("password rules", () => {
  test("emails are trimmed and lowercased", () => {
    expect(normalizeEmail("  Bob@Gmail.COM ")).toBe("bob@gmail.com");
    expect(normalizeEmail(undefined)).toBe("");
    expect(isEmail("bob@gmail.com")).toBe(true);
    expect(isEmail("bob@gmail")).toBe(false);
  });

  test.each([
    ["short", "bob@gmail.com", /at least 12/],
    ["x".repeat(129), "bob@gmail.com", /at most 128/],
    ["BOB@gmail.com", "bob@gmail.com", /can't be your email/],
    ["bobbybobbybob", "bobbybobbybob@gmail.com", /can't be your email/],
  ])("rejects %s", (password, email, message) => {
    expect(passwordProblem(password, email)).toMatch(message);
  });

  test("accepts a long passphrase", () => {
    expect(passwordProblem("correct-horse-candle", "bob@gmail.com")).toBeNull();
  });

  test("argon2 round trip, and old bcrypt hashes still work but ask for an upgrade", async () => {
    const argon = await hashPassword("correct-horse-candle");
    expect(argon).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(argon, "correct-horse-candle")).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword(argon, "wrong")).toEqual({ ok: false, needsRehash: false });
    const old = await bcrypt.hash("old-password", 4);
    expect(await verifyPassword(old, "old-password")).toEqual({ ok: true, needsRehash: true });
  });
});

describe("leaked-password check", () => {
  // SHA-1 of "password" is 5BAA6 1E4C9B93F3F0682250B6CF8331B7EE68FD8
  test("finds a leaked password from the 5-character range only", async () => {
    const fetchImpl = fetchReturning("0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824");
    expect(await isLeakedPassword("password", fetchImpl)).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.pwnedpasswords.com/range/5BAA6");
  });

  test("padding rows with a zero count don't count", async () => {
    expect(await isLeakedPassword("password", fetchReturning("1E4C9B93F3F0682250B6CF8331B7EE68FD8:0"))).toBe(false);
  });

  test("if the service is down the password is allowed", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    const failing = jest.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await isLeakedPassword("password", failing)).toBe(false);
  });
});

describe("lockout", () => {
  test("waits grow with each block of 5 failures, up to an hour", () => {
    expect([0, 4, 5, 9, 10, 15, 20, 25, 60].map(lockMinutes)).toEqual([0, 0, 5, 5, 10, 20, 40, 60, 60]);
  });

  test("human check after 3 failures, lock after 5", () => {
    const now = Date.now();
    expect(loginState({ failures: 2, lastFailureAt: new Date(now) }, now)).toEqual({
      failures: 2,
      captchaRequired: false,
      retryAfter: 0,
      attemptsLeft: 3,
    });
    expect(loginState({ failures: 5, lastFailureAt: new Date(now - 60000) }, now)).toMatchObject({
      captchaRequired: true,
      retryAfter: 240,
      attemptsLeft: 0,
    });
    expect(loginState({ failures: 5, lastFailureAt: new Date(now - 6 * 60000) }, now).retryAfter).toBe(0);
  });
});

describe("Turnstile", () => {
  test("off without a secret", async () => {
    expect(await verifyTurnstile(undefined, "1.2.3.4")).toBe(true);
  });

  test("with a secret, asks Cloudflare and needs a token", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    expect(await verifyTurnstile("", "1.2.3.4", fetchReturning("{}"))).toBe(false);
    const fetchImpl = fetchReturning('{"success":true}');
    expect(await verifyTurnstile("token", "1.2.3.4", fetchImpl)).toBe(true);
    expect(String(fetchImpl.mock.calls[0][1].body)).toContain("remoteip=1.2.3.4");
    expect(await verifyTurnstile("token", "1.2.3.4", fetchReturning('{"success":false}'))).toBe(false);
  });
});

test("session cookie is HttpOnly, Secure, SameSite=Lax; 30 days only when remembered", () => {
  expect(cookieOptions(false)).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  expect(cookieOptions(true).maxAge).toBe(30 * 24 * 60 * 60 * 1000);
});

describe("POST /login", () => {
  let argonHash;
  beforeAll(async () => {
    argonHash = await hashPassword("correct-horse-candle");
  });
  const user = () => ({ id: 7, name: "Bro", email: "bob@gmail.com", password_hash: argonHash, email_verified_at: new Date() });
  const noFailures = [/FROM login_attempts/, { rows: [{ failures: 0, lastFailureAt: null }] }];

  test("logs in with any capitalisation of the email and sets the session cookie", async () => {
    const calls = fakeDb([noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    const response = await request(app)
      .post("/login")
      .send({ email: " Bob@Gmail.com ", password: "correct-horse-candle", remember: true });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ id: 7, name: "Bro", email: "bob@gmail.com", demo: false });
    const cookie = response.headers["set-cookie"][0];
    expect(cookie).toMatch(/^mnq_session=[\w-]{43};/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);

    const sessionInsert = calls.find((c) => /INSERT INTO sessions/.test(c.sql));
    const token = cookie.split(";")[0].split("=")[1];
    expect(sessionInsert.params[1]).toBe(hashToken(token)); // only the hash is stored
    expect(calls.find((c) => /FROM users WHERE email/.test(c.sql)).params).toEqual(["bob@gmail.com"]);
    expect(calls.some((c) => /INSERT INTO login_attempts/.test(c.sql) && c.params[2] === true)).toBe(true);
  });

  test("without 'keep me logged in' the cookie ends with the browser", async () => {
    fakeDb([noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(response.headers["set-cookie"][0]).not.toMatch(/Max-Age/);
  });

  test("an old bcrypt password is upgraded to argon2 on login", async () => {
    const old = await bcrypt.hash("old-password-123", 4);
    const calls = fakeDb([noFailures, [/FROM users WHERE email/, { rows: [{ ...user(), password_hash: old }] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "old-password-123" });
    expect(response.status).toBe(200);
    const upgrade = calls.find((c) => /UPDATE users SET password_hash/.test(c.sql));
    expect(upgrade.params[0]).toMatch(/^\$argon2id\$/);
  });

  test("wrong password and unknown email get the same answer", async () => {
    fakeDb([noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    const wrong = await request(app).post("/login").send({ email: "bob@gmail.com", password: "nope" });
    fakeDb([noFailures]);
    const unknown = await request(app).post("/login").send({ email: "nobody@gmail.com", password: "nope" });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body).toEqual({ error: "Email or password is wrong.", attemptsLeft: 4, captchaRequired: false });
  });

  test("the 5th failure locks the email", async () => {
    fakeDb([[/FROM login_attempts/, { rows: [{ failures: 4, lastFailureAt: new Date() }] }], [/FROM users WHERE email/, { rows: [user()] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "nope" });
    expect(response.status).toBe(429);
    expect(response.body.retryAfter).toBe(300);
    expect(response.headers["retry-after"]).toBe("300");
  });

  test("while locked, even the right password is refused without being checked", async () => {
    const calls = fakeDb([[/FROM login_attempts/, { rows: [{ failures: 5, lastFailureAt: new Date() }] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(response.status).toBe(429);
    expect(calls.some((c) => /FROM users/.test(c.sql))).toBe(false);
  });

  test("after 3 failures the human check is required when Turnstile is on", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    fakeDb([[/FROM login_attempts/, { rows: [{ failures: 3, lastFailureAt: new Date() }] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ captchaRequired: true, attemptsLeft: 2 });
  });

  test("an unconfirmed email can't log in yet (only shown to someone with the right password)", async () => {
    const calls = fakeDb([noFailures, [/FROM users WHERE email/, { rows: [{ ...user(), email_verified_at: null }] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Please confirm your email first.", unverified: true });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(calls.some((c) => /INSERT INTO sessions/.test(c.sql))).toBe(false);
  });

  test("the login that locks an account emails its owner", async () => {
    fakeDb([[/FROM login_attempts/, { rows: [{ failures: 4, lastFailureAt: new Date() }] }], [/FROM users WHERE email/, { rows: [user()] }]]);
    await request(app).post("/login").send({ email: "bob@gmail.com", password: "nope" });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "bob@gmail.com", subject: "Your account was locked for a few minutes" }));
  });

  test("a browser never used before gets a new-login email; a known one doesn't", async () => {
    const seen = (sameDevice) => [/bool_or/, { rows: [{ same_device: sameDevice, logins: 3 }] }];
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
    fakeDb([seen(false), noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    await request(app).post("/login").set("User-Agent", ua).send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].text).toContain("Safari on iPhone");

    sendMail.mockClear();
    fakeDb([seen(true), noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    await request(app).post("/login").set("User-Agent", ua).send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test("the login response carries no token, only the cookie", async () => {
    fakeDb([noFailures, [/FROM users WHERE email/, { rows: [user()] }]]);
    const response = await request(app).post("/login").send({ email: "bob@gmail.com", password: "correct-horse-candle" });
    expect(Object.keys(response.body)).toEqual(["user"]);
  });

  test("a write from another website is blocked", async () => {
    const response = await request(app).post("/login").set("Origin", "https://evil.example").send({});
    expect(response.status).toBe(403);
  });

  test("per-IP limit: 30 tries per 15 minutes through Nginx", async () => {
    fakeDb([]);
    const send = () => request(app).post("/login").set("X-Forwarded-For", "203.0.113.9").send({});
    for (let i = 0; i < 30; i += 1) expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  });
});

describe("POST /register", () => {
  const valid = { name: "Bro", email: "New@Gmail.com", password: "correct-horse-candle", acceptTerms: true };

  test("rejects a short password before doing any work", async () => {
    const calls = fakeDb([]);
    const response = await request(app).post("/register").send({ ...valid, password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/at least 12/);
    expect(calls).toHaveLength(0);
  });

  test("needs the Terms accepted", async () => {
    const calls = fakeDb([]);
    const response = await request(app).post("/register").send({ ...valid, acceptTerms: false });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Terms/);
    expect(calls).toHaveLength(0);
  });

  test("rejects a leaked password", async () => {
    fakeDb([]);
    // SHA-1 of "correct-horse-candle", with a positive count
    const sha1 = require("crypto").createHash("sha1").update(valid.password).digest("hex").toUpperCase();
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(`${sha1.slice(5)}:12`));
    const response = await request(app).post("/register").send(valid);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/data leak/);
  });

  test("creates the account and starter lists in one transaction, then emails a link", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const calls = fakeDb([[/INSERT INTO users/, { rows: [{ id: 42, name: "Bro", email: "new@gmail.com" }] }], [/INSERT INTO tag_groups/, { rows: [{ id: 1 }] }], [/SELECT count\(\*\)::int AS n FROM email_tokens/, { rows: [{ n: 0 }] }]]);
    const response = await request(app).post("/register").send(valid);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ message: "Check your email." });
    expect(response.headers["set-cookie"]).toBeUndefined(); // not logged in until confirmed
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "new@gmail.com", subject: "Confirm your email" }));
    const link = sendMail.mock.calls[0][0].text.match(/verify-email\?token=([\w-]+)/)[1];
    expect(calls.find((c) => /INSERT INTO email_tokens/.test(c.sql)).params[2]).toBe(hashToken(link));
    const sqls = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.indexOf("COMMIT")).toBeGreaterThan(sqls.indexOf("INSERT INTO mistakes"));
    expect(calls.find((c) => /INSERT INTO users/.test(c.sql)).params[2]).toMatch(/^\$argon2id\$/);
  });

  test("per-IP sign-up limit counts only accounts created", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const send = (body) => request(app).post("/register").set("X-Forwarded-For", "203.0.113.20").send(body);
    // Failed tries (weak password) never use up the limit
    for (let i = 0; i < 12; i += 1) expect((await send({ ...valid, password: "short" })).status).toBe(400);
    fakeDb([[/INSERT INTO users/, { rows: [{ id: 42, name: "Bro", email: "new@gmail.com" }] }], [/INSERT INTO tag_groups/, { rows: [{ id: 1 }] }], [/SELECT count\(\*\)::int AS n FROM email_tokens/, { rows: [{ n: 0 }] }]]);
    for (let i = 0; i < 10; i += 1) expect((await send(valid)).status).toBe(202);
    expect((await send(valid)).status).toBe(429);
  });

  test("a taken email gets the same answer; the owner gets a heads-up instead", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const calls = fakeDb([[/FROM users WHERE email/, { rows: [{ id: 7, name: "Bro", email: "new@gmail.com", email_verified_at: new Date() }] }]]);
    const response = await request(app).post("/register").send(valid);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ message: "Check your email." });
    expect(calls.map((c) => c.sql)).toContain("ROLLBACK");
    expect(calls.some((c) => /INSERT INTO mistakes/.test(c.sql))).toBe(false);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: "Someone tried to sign up with your email" }));
  });

  test("an unconfirmed account signing up again just gets a fresh link", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const calls = fakeDb([
      [/FROM users WHERE email/, { rows: [{ id: 7, name: "Bro", email: "new@gmail.com", email_verified_at: null }] }],
      [/SELECT count\(\*\)::int AS n FROM email_tokens/, { rows: [{ n: 0 }] }],
    ]);
    expect((await request(app).post("/register").send(valid)).status).toBe(202);
    expect(sendMail.mock.calls[0][0].subject).toBe("Confirm your email");
    expect(calls.some((c) => /UPDATE users SET password_hash/.test(c.sql))).toBe(false); // password unchanged
  });

  test("no more than 3 links an hour per account", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    fakeDb([
      [/FROM users WHERE email/, { rows: [{ id: 7, name: "Bro", email: "new@gmail.com", email_verified_at: null }] }],
      [/SELECT count\(\*\)::int AS n FROM email_tokens/, { rows: [{ n: 3 }] }],
    ]);
    expect((await request(app).post("/register").send(valid)).status).toBe(202);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("email links", () => {
  const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  const linkUser = { id: 7, name: "Bro", email: "bob@gmail.com" };
  const noRecentTokens = [/SELECT count\(\*\)::int AS n FROM email_tokens/, { rows: [{ n: 0 }] }];

  test("confirming the email logs in and uses up the link", async () => {
    const calls = fakeDb([[/UPDATE email_tokens t SET used_at/, { rows: [{ ...linkUser, email_verified_at: null }] }]]);
    const response = await request(app).post("/verify-email").send({ token: TOKEN });
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ ...linkUser, demo: false });
    expect(response.headers["set-cookie"][0]).toMatch(/^mnq_session=/);
    expect(calls[0].params).toEqual([hashToken(TOKEN), "verify"]);
    expect(calls.some((c) => /SET email_verified_at = coalesce/.test(c.sql))).toBe(true);
  });

  test("a used or expired link says so", async () => {
    fakeDb([]);
    const response = await request(app).post("/verify-email").send({ token: TOKEN });
    expect(response.status).toBe(400);
    expect(response.body.expired).toBe(true);
    expect((await request(app).post("/verify-email").send({ token: "short" })).status).toBe(400);
  });

  test("forgot password answers the same for any email, and emails only real accounts", async () => {
    fakeDb([noRecentTokens]);
    const unknown = await request(app).post("/forgot-password").send({ email: "nobody@gmail.com" });
    expect(sendMail).not.toHaveBeenCalled();
    fakeDb([[/FROM users WHERE email/, { rows: [linkUser] }], noRecentTokens]);
    const known = await request(app).post("/forgot-password").send({ email: "Bob@Gmail.com" });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(sendMail.mock.calls[0][0].text).toMatch(/reset-password\?token=[\w-]{43}/);
  });

  test("forgot password needs the human check when Turnstile is on", async () => {
    process.env.TURNSTILE_SECRET = "test-secret";
    fakeDb([]);
    const response = await request(app).post("/forgot-password").send({ email: "bob@gmail.com" });
    expect(response.status).toBe(400);
    expect(response.body.captchaRequired).toBe(true);
  });

  test("resending the confirmation link only emails unconfirmed accounts", async () => {
    fakeDb([[/FROM users WHERE email/, { rows: [{ ...linkUser, email_verified_at: new Date() }] }], noRecentTokens]);
    expect((await request(app).post("/resend-verification").send({ email: "bob@gmail.com" })).status).toBe(202);
    expect(sendMail).not.toHaveBeenCalled();
    fakeDb([[/FROM users WHERE email/, { rows: [{ ...linkUser, email_verified_at: null }] }], noRecentTokens]);
    expect((await request(app).post("/resend-verification").send({ email: "bob@gmail.com" })).status).toBe(202);
    expect(sendMail.mock.calls[0][0].subject).toBe("Confirm your email");
  });

  test("the reset page can check a link first", async () => {
    fakeDb([[/FROM email_tokens t JOIN users/, { rows: [linkUser] }]]);
    expect((await request(app).post("/reset-password/check").send({ token: TOKEN })).body).toEqual({ email: "bob@gmail.com" });
    fakeDb([]);
    expect((await request(app).post("/reset-password/check").send({ token: TOKEN })).status).toBe(400);
  });

  test("a reset sets the password, ends other sessions and the lockout, logs in, and emails a notice", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const calls = fakeDb([
      [/FROM email_tokens t JOIN users/, { rows: [linkUser] }],
      [/UPDATE email_tokens t SET used_at/, { rows: [{ ...linkUser, email_verified_at: null }] }],
    ]);
    const response = await request(app).post("/reset-password").send({ token: TOKEN, password: "violet-kettle-moonrise" });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"][0]).toMatch(/^mnq_session=/);
    const update = calls.find((c) => /UPDATE users SET password_hash/.test(c.sql));
    expect(update.params[0]).toMatch(/^\$argon2id\$/);
    expect(update.sql).toMatch(/email_verified_at = coalesce/);
    expect(calls.some((c) => /UPDATE sessions SET revoked_at = now\(\) WHERE user_id/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO login_attempts/.test(c.sql) && c.params[2] === true)).toBe(true);
    expect(sendMail.mock.calls[0][0].subject).toBe("Your password was changed");
  });

  test("a reset can keep other devices logged in", async () => {
    jest.spyOn(global, "fetch").mockImplementation(fetchReturning(""));
    const calls = fakeDb([
      [/FROM email_tokens t JOIN users/, { rows: [linkUser] }],
      [/UPDATE email_tokens t SET used_at/, { rows: [linkUser] }],
    ]);
    await request(app).post("/reset-password").send({ token: TOKEN, password: "violet-kettle-moonrise", logoutOthers: false });
    expect(calls.some((c) => /UPDATE sessions SET revoked_at = now\(\) WHERE user_id/.test(c.sql))).toBe(false);
  });

  test("a weak new password is refused and the link stays usable", async () => {
    const calls = fakeDb([[/FROM email_tokens t JOIN users/, { rows: [linkUser] }]]);
    const response = await request(app).post("/reset-password").send({ token: TOKEN, password: "short" });
    expect(response.status).toBe(400);
    expect(calls.some((c) => /UPDATE email_tokens t SET used_at/.test(c.sql))).toBe(false);
  });
});

describe("email content", () => {
  const emails = require("../utils/emails");
  const { RESERVED } = jest.requireActual("../utils/mailer");

  test("links point at the site and names are escaped in HTML", () => {
    process.env.APP_URL = "https://bro-trading.duckdns.org/";
    const mail = emails.verifyEmail("<b>Bro</b>", "TOKEN123");
    expect(mail.text).toContain("https://bro-trading.duckdns.org/verify-email?token=TOKEN123");
    expect(mail.html).toContain("&lt;b&gt;Bro&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Bro</b>");
    delete process.env.APP_URL;
  });

  test("device names", () => {
    expect(emails.describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(emails.describeDevice("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0")).toBe("Edge on Windows");
    expect(emails.describeDevice("")).toBe("a browser on an unknown device");
  });

  test("reserved test addresses never get mail", () => {
    expect(RESERVED.test("giyotest@example.com")).toBe(true);
    expect(RESERVED.test("a@b.test")).toBe(true);
    expect(RESERVED.test("bob@gmail.com")).toBe(false);
  });
});

describe("sessions", () => {
  test("GET /me with a live session cookie", async () => {
    const calls = fakeDb([
      [/FROM sessions s JOIN users/, { rows: [{ id: 3, user_id: 7, last_seen_at: new Date() }] }],
      [/FROM users WHERE id/, { rows: [{ id: 7, name: "Bro", email: "bob@gmail.com" }] }],
    ]);
    const response = await request(app).get("/me").set("Cookie", "mnq_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe("bob@gmail.com");
    expect(calls[0].params).toEqual([hashToken("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")]);
  });

  test("old Bearer tokens no longer work", async () => {
    fakeDb([]);
    const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6N30.c2lnbmF0dXJl";
    expect((await request(app).get("/me").set("Authorization", `Bearer ${jwtLike}`)).status).toBe(401);
  });

  test("GET /me without a session is 401", async () => {
    fakeDb([]);
    expect((await request(app).get("/me")).status).toBe(401);
    expect((await request(app).get("/me").set("Cookie", "mnq_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG")).status).toBe(401);
  });

  test("logout ends the session on the server and clears the cookie", async () => {
    const calls = fakeDb([]);
    const response = await request(app).post("/logout").set("Cookie", "mnq_session=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    expect(response.status).toBe(204);
    expect(calls[0].sql).toMatch(/UPDATE sessions SET revoked_at/);
    expect(response.headers["set-cookie"][0]).toMatch(/mnq_session=;.*Expires=Thu, 01 Jan 1970/);
  });
});

test("security headers are set", async () => {
  const response = await request(app).get("/");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["x-powered-by"]).toBeUndefined();
});
