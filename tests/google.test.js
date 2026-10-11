const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
// The fake Google check: "good:<sub>:<email>" tokens are valid, anything else isn't
jest.mock("../utils/google", () => ({
  googleEnabled: () => true,
  verifyGoogleCredential: jest.fn(async (credential) => {
    const m = /^good:(\w+):(.+)$/.exec(credential || "");
    return m ? { sub: m[1], email: m[2], name: "Google Name" } : null;
  }),
}));
let mockSession = { id: "3", user_id: 7, email: "bob@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));

const pool = require("../db");
const app = require("../app");
const { hashPassword } = require("../utils/passwords");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
afterEach(() => {
  jest.restoreAllMocks();
  mockSession = { id: "3", user_id: 7, email: "bob@gmail.com" };
});

function fakeDb(handlers) {
  const calls = [];
  const query = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, answer] of handlers) {
      if (pattern.test(sql)) return typeof answer === "function" ? answer(params) : answer;
    }
    return { rows: [], rowCount: 0 };
  });
  jest.spyOn(pool, "query").mockImplementation(query);
  jest.spyOn(pool, "connect").mockResolvedValue({ query, release: () => {} });
  return calls;
}

describe("POST /auth/google", () => {
  test("a token Google didn't sign is refused", async () => {
    fakeDb([]);
    const response = await request(app).post("/auth/google").send({ credential: "forged" });
    expect(response.status).toBe(401);
  });

  test("a connected Google account logs straight in", async () => {
    const calls = fakeDb([[/WHERE google_sub = \$1/, { rows: [{ id: 7, name: "Bro", email: "bob@gmail.com" }] }]]);
    const response = await request(app).post("/auth/google").send({ credential: "good:g123:bob@gmail.com" });
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({ id: 7, name: "Bro", email: "bob@gmail.com", demo: false });
    expect(response.headers["set-cookie"][0]).toMatch(/^mnq_session=.*Max-Age=2592000/);
    expect(calls.some((c) => /INSERT INTO users/.test(c.sql))).toBe(false);
  });

  test("an email that already has a password account is not taken over", async () => {
    const calls = fakeDb([[/SELECT id FROM users WHERE email = \$1/, { rows: [{ id: 7 }] }]]);
    const response = await request(app).post("/auth/google").send({ credential: "good:g999:bob@gmail.com", acceptTerms: true });
    expect(response.status).toBe(409);
    expect(response.body.linkRequired).toBe(true);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(calls.some((c) => /UPDATE users SET google_sub/.test(c.sql))).toBe(false);
  });

  test("a new Google user is asked for the Terms first", async () => {
    const calls = fakeDb([]);
    const response = await request(app).post("/auth/google").send({ credential: "good:g555:new@gmail.com" });
    expect(response.body).toEqual({ needsSignup: true, email: "new@gmail.com", name: "Google Name" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(calls.some((c) => /INSERT INTO users/.test(c.sql))).toBe(false);
  });

  test("then the account is created, confirmed, with no password, and logged in", async () => {
    const calls = fakeDb([
      [/INSERT INTO users/, { rows: [{ id: 50, name: "My Name", email: "new@gmail.com" }] }],
      [/INSERT INTO tag_groups/, { rows: [{ id: 1 }] }],
    ]);
    const response = await request(app)
      .post("/auth/google")
      .send({ credential: "good:g555:new@gmail.com", acceptTerms: true, name: " My Name " });
    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"][0]).toMatch(/^mnq_session=/);
    const insert = calls.find((c) => /INSERT INTO users/.test(c.sql));
    expect(insert.sql).toMatch(/password_hash.*NULL/s);
    expect(insert.sql).toMatch(/email_verified_at, terms_accepted_at\)\s+VALUES \(\$1, \$2, NULL, \$3, \$4, now\(\), now\(\)\)/);
    expect(insert.params).toEqual(["My Name", "new@gmail.com", "g555", "new@gmail.com"]);
    expect(calls.some((c) => /INSERT INTO mistakes/.test(c.sql))).toBe(true);
  });
});

test("a password login to a Google-only account fails like a wrong password", async () => {
  fakeDb([
    [/FROM login_attempts/, { rows: [{ failures: 0, lastFailureAt: null }] }],
    [/FROM users WHERE email/, { rows: [{ id: 50, name: "G", email: "new@gmail.com", password_hash: null, email_verified_at: new Date() }] }],
  ]);
  const response = await request(app).post("/login").send({ email: "new@gmail.com", password: "anything-at-all" });
  expect(response.status).toBe(401);
  expect(response.body.error).toBe("Email or password is wrong.");
});

describe("Account page: Google", () => {
  const googleOnly = (extra = {}) => [
    /FROM users WHERE id = \$1/,
    { rows: [{ id: 7, name: "Bro", email: "bob@gmail.com", password_hash: null, google_sub: "g123", google_email: "bob@gmail.com", email_verified_at: new Date(), created_at: new Date(), ...extra }] },
  ];

  test("GET /account says which sign-in methods are on", async () => {
    fakeDb([googleOnly(), [/AS used/, { rows: [{ used: "0" }] }]]);
    const response = await request(app).get("/account").set(COOKIE);
    expect(response.body.signIn).toEqual({ password: false, google: "bob@gmail.com" });
  });

  test("connect Google, unless it belongs to another journal", async () => {
    const calls = fakeDb([]);
    const ok = await request(app).post("/account/google").set(COOKIE).send({ credential: "good:g777:other@gmail.com" });
    expect(ok.body).toEqual({ google: "other@gmail.com" });
    expect(calls.find((c) => /UPDATE users SET google_sub/.test(c.sql)).params).toEqual(["g777", "other@gmail.com", 7]);

    fakeDb([[/WHERE google_sub = \$1 AND id <> \$2/, { rows: [{ id: 99 }] }]]);
    const taken = await request(app).post("/account/google").set(COOKIE).send({ credential: "good:g777:other@gmail.com" });
    expect(taken.status).toBe(409);
  });

  test("Google can't be disconnected while it's the only way in", async () => {
    fakeDb([googleOnly()]);
    expect((await request(app).delete("/account/google").set(COOKIE)).status).toBe(400);
    const calls = fakeDb([googleOnly({ password_hash: await hashPassword("violet-kettle-moonrise") })]);
    expect((await request(app).delete("/account/google").set(COOKIE)).status).toBe(204);
    expect(calls.some((c) => /SET google_sub = NULL/.test(c.sql))).toBe(true);
  });

  test("setting a first password needs a fresh Google confirmation", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    fakeDb([googleOnly(), [/FROM login_attempts/, { rows: [{ failures: 0, lastFailureAt: null }] }]]);
    const without = await request(app).post("/account/password").set(COOKIE).send({ newPassword: "violet-kettle-moonrise" });
    expect(without.status).toBe(400);
    expect(without.body.googleRequired).toBe(true);
    const wrong = await request(app).post("/account/password").set(COOKIE).send({ newPassword: "violet-kettle-moonrise", googleCredential: "good:g000:bob@gmail.com" });
    expect(wrong.status).toBe(400);

    const calls = fakeDb([googleOnly(), [/FROM login_attempts/, { rows: [{ failures: 0, lastFailureAt: null }] }]]);
    const ok = await request(app).post("/account/password").set(COOKIE).send({ newPassword: "violet-kettle-moonrise", googleCredential: "good:g123:bob@gmail.com" });
    expect(ok.status).toBe(200);
    expect(calls.find((c) => /UPDATE users SET password_hash/.test(c.sql)).params[0]).toMatch(/^\$argon2id\$/);
  });

  test("deleting a Google-only account needs a fresh Google confirmation", async () => {
    fakeDb([googleOnly()]);
    const without = await request(app).delete("/account").set(COOKIE).send({ confirm: "DELETE" });
    expect(without.body.googleRequired).toBe(true);
    const calls = fakeDb([googleOnly()]);
    const ok = await request(app).delete("/account").set(COOKIE).send({ confirm: "DELETE", googleCredential: "good:g123:bob@gmail.com" });
    expect(ok.status).toBe(204);
    expect(calls.some((c) => /DELETE FROM users/.test(c.sql))).toBe(true);
  });
});
