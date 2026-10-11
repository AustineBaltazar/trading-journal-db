const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
let mockSession = { id: "3", user_id: 7, email: "bob@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));
jest.mock("../utils/s3", () => ({
  imagesConfigured: () => true,
  deleteObject: jest.fn(async () => {}),
  uploadUrl: jest.fn(async () => "https://bucket.s3.amazonaws.com/signed"),
}));

const { sendMail } = require("../utils/mailer");
const s3 = require("../utils/s3");
const pool = require("../db");
const app = require("../app");
const { hashPassword } = require("../utils/passwords");
const { maskIp, toCsv, csvCell, STORAGE_LIMIT_BYTES } = require("../utils/account");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
let argonHash;
beforeAll(async () => {
  argonHash = await hashPassword("correct-horse-candle");
});
afterEach(() => {
  jest.restoreAllMocks();
  sendMail.mockClear();
  s3.deleteObject.mockClear();
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
const me = () => [/FROM users WHERE id = \$1/, { rows: [{ id: 7, name: "Bro", email: "bob@gmail.com", password_hash: argonHash, email_verified_at: new Date(), created_at: new Date() }] }];
const noFailures = [/FROM login_attempts\s+WHERE email = \$1 AND NOT succeeded/, { rows: [{ failures: 0, lastFailureAt: null }] }];

describe("helpers", () => {
  test("IPs are shown with the last part hidden", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.113.x");
    expect(maskIp("::ffff:203.0.113.42")).toBe("203.0.113.x");
    expect(maskIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3:…");
    expect(maskIp(null)).toBeNull();
  });

  test("CSV quotes commas and stops spreadsheet formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("'-12.5");
    expect(toCsv(["a", "b"], [{ a: 1, b: null }])).toBe("a,b\r\n1,");
  });
});

describe("read-only demo", () => {
  beforeEach(() => {
    mockSession = { id: 3, user_id: 11, email: "giyotest@example.com" };
  });

  test("can look but not change anything", async () => {
    fakeDb([[/FROM trades/, { rows: [] }]]);
    expect((await request(app).get("/trades").set(COOKIE)).status).toBe(200);
    const write = await request(app).post("/trades").set(COOKIE).send({});
    expect(write.status).toBe(403);
    expect(write.body.demo).toBe(true);
    expect((await request(app).delete("/account").set(COOKIE).send({ confirm: "DELETE" })).status).toBe(403);
    expect((await request(app).post("/account/password").set(COOKIE).send({})).status).toBe(403);
  });

  test("can still send feedback", async () => {
    fakeDb([[/SELECT count\(\*\)::int AS n FROM feedback/, { rows: [{ n: 0 }] }], [/SELECT name, email FROM users/, { rows: [{ name: "Demo", email: "giyotest@example.com" }] }]]);
    const response = await request(app).post("/feedback").set(COOKIE).send({ kind: "idea", message: "Nice charts" });
    expect(response.status).toBe(201);
  });
});

describe("storage limit", () => {
  test("a screenshot that would pass 200 MB is refused", async () => {
    fakeDb([
      [/SELECT id FROM trades WHERE id/, { rows: [{ id: 5 }] }],
      [/count\(\*\)::int AS n FROM trade_images/, { rows: [{ n: 0 }] }],
      [/AS used/, { rows: [{ used: String(STORAGE_LIMIT_BYTES - 1000) }] }],
    ]);
    const response = await request(app)
      .post("/trades/5/images/upload-url")
      .set(COOKIE)
      .send({ content_type: "image/png", size_bytes: 2000 });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/200 MB/);
  });

  test("under the limit it gets an upload link", async () => {
    fakeDb([
      [/SELECT id FROM trades WHERE id/, { rows: [{ id: 5 }] }],
      [/count\(\*\)::int AS n FROM trade_images/, { rows: [{ n: 0 }] }],
      [/AS used/, { rows: [{ used: "1000" }] }],
    ]);
    const response = await request(app)
      .post("/trades/5/images/upload-url")
      .set(COOKIE)
      .send({ content_type: "image/png", size_bytes: 2000 });
    expect(response.status).toBe(200);
  });
});

describe("account page", () => {
  test("GET /account shows profile and storage", async () => {
    fakeDb([me(), [/AS used/, { rows: [{ used: "52428800" }] }]]);
    const response = await request(app).get("/account").set(COOKIE);
    expect(response.body).toMatchObject({
      user: { id: 7, name: "Bro", email: "bob@gmail.com", demo: false },
      emailConfirmed: true,
      storage: { usedBytes: 52428800, limitBytes: STORAGE_LIMIT_BYTES },
    });
    expect(response.body.user.password_hash).toBeUndefined();
  });

  test("name can be changed", async () => {
    const calls = fakeDb([[/UPDATE users SET name/, { rows: [{ id: 7, name: "Bro 2", email: "bob@gmail.com" }] }]]);
    expect((await request(app).put("/account/profile").set(COOKIE).send({ name: " Bro 2 " })).status).toBe(200);
    expect(calls[calls.length - 1].params).toEqual(["Bro 2", 7]);
    expect((await request(app).put("/account/profile").set(COOKIE).send({ name: "" })).status).toBe(400);
  });

  test("lists this account's devices with the current one marked", async () => {
    fakeDb([
      [/FROM sessions\s+WHERE user_id/, { rows: [
        { id: "3", user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", ip: "203.0.113.42", created_at: new Date(), last_seen_at: new Date() },
        { id: "9", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1", ip: "198.51.100.7", created_at: new Date(), last_seen_at: new Date() },
      ] }],
    ]);
    const { body } = await request(app).get("/account/sessions").set(COOKIE);
    expect(body.sessions.map((s) => [s.device, s.ip, s.current])).toEqual([
      ["Chrome on Windows", "203.0.113.x", true],
      ["Safari on iPhone", "198.51.100.x", false],
    ]);
  });

  test("logging out another device only touches this account's sessions", async () => {
    const calls = fakeDb([[/UPDATE sessions SET revoked_at = now\(\) WHERE id = \$1 AND user_id = \$2/, { rowCount: 1 }]]);
    expect((await request(app).delete("/account/sessions/9").set(COOKIE)).status).toBe(204);
    expect(calls[calls.length - 1].params).toEqual([9, 7]);
    fakeDb([]);
    expect((await request(app).delete("/account/sessions/99").set(COOKIE)).status).toBe(404);
    expect((await request(app).delete("/account/sessions/3").set(COOKIE)).status).toBe(400); // this device: use Log out
  });

  test("log out all other devices keeps this one", async () => {
    const calls = fakeDb([[/UPDATE sessions/, { rowCount: 2 }]]);
    const response = await request(app).post("/account/sessions/logout-others").set(COOKIE);
    expect(response.body).toEqual({ loggedOut: 2 });
    expect(calls[calls.length - 1].sql).toMatch(/id <> \$2/);
    expect(calls[calls.length - 1].params).toEqual([7, "3"]);
  });
});

describe("change password", () => {
  test("a wrong current password is refused and counts toward the lockout", async () => {
    const calls = fakeDb([me(), noFailures]);
    const response = await request(app).post("/account/password").set(COOKIE).send({ currentPassword: "nope", newPassword: "violet-kettle-moonrise" });
    expect(response.status).toBe(400);
    expect(calls.some((c) => /INSERT INTO login_attempts/.test(c.sql) && c.params[2] === false)).toBe(true);
    expect(calls.some((c) => /UPDATE users SET password_hash/.test(c.sql))).toBe(false);
  });

  test("changes it, logs out other devices and emails a notice", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, text: async () => "" });
    const calls = fakeDb([me(), noFailures]);
    const response = await request(app).post("/account/password").set(COOKIE).send({ currentPassword: "correct-horse-candle", newPassword: "violet-kettle-moonrise" });
    expect(response.status).toBe(200);
    expect(calls.find((c) => /UPDATE users SET password_hash/.test(c.sql)).params[0]).toMatch(/^\$argon2id\$/);
    expect(calls.find((c) => /UPDATE sessions SET revoked_at/.test(c.sql)).params).toEqual([7, "3"]);
    expect(sendMail.mock.calls[0][0].subject).toBe("Your password was changed");
  });

  test("the new password follows the usual rules", async () => {
    fakeDb([me(), noFailures]);
    const response = await request(app).post("/account/password").set(COOKIE).send({ currentPassword: "correct-horse-candle", newPassword: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/12/);
  });
});

describe("export", () => {
  test("trades as CSV", async () => {
    fakeDb([[/FROM trades WHERE user_id/, { rows: [{ id: 1, trade_date: "2026-10-01", symbol: "MNQ", emotions: ["Calm", "Confident"], notes: '=cmd|"x"' }] }]]);
    const response = await request(app).get("/account/export/trades.csv").set(COOKIE);
    expect(response.headers["content-disposition"]).toMatch(/attachment; filename="mnq-journal-trades-/);
    const [header, row] = response.text.replace("﻿", "").split("\r\n");
    expect(header.startsWith("id,trade_date,mode,symbol")).toBe(true);
    expect(row).toContain("2026-10-01");
    expect(row).toContain("Calm; Confident");
    expect(row).toContain(`"'=cmd|""x"""`);
  });

  test("everything as JSON, without internal ids or password", async () => {
    fakeDb([[/SELECT name, email, created_at FROM users/, { rows: [{ name: "Bro", email: "bob@gmail.com" }] }], [/SELECT \*, trade_date::text AS trade_date FROM trades/, { rows: [{ id: 1, user_id: 7, symbol: "MNQ" }] }]]);
    const response = await request(app).get("/account/export").set(COOKIE);
    expect(response.headers["content-disposition"]).toMatch(/attachment/);
    expect(response.body.account).toEqual({ name: "Bro", email: "bob@gmail.com" });
    expect(response.body.trades).toEqual([{ id: 1, symbol: "MNQ" }]);
    expect(JSON.stringify(response.body)).not.toMatch(/password/);
  });
});

describe("delete account", () => {
  test("needs DELETE typed and the right password", async () => {
    fakeDb([me()]);
    expect((await request(app).delete("/account").set(COOKIE).send({ password: "correct-horse-candle", confirm: "delete" })).status).toBe(400);
    const wrong = await request(app).delete("/account").set(COOKIE).send({ password: "nope", confirm: "DELETE" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/password is wrong/);
  });

  test("deletes everything in one transaction, then the screenshots, and logs out", async () => {
    const calls = fakeDb([me(), [/SELECT i\.s3_key/, { rows: [{ s3_key: "users/7/trades/1/a.png" }, { s3_key: "users/7/journal/2/b.png" }] }]]);
    const response = await request(app).delete("/account").set(COOKIE).send({ password: "correct-horse-candle", confirm: "DELETE" });
    expect(response.status).toBe(204);
    const sqls = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    const order = ["BEGIN", "DELETE FROM answers", "DELETE FROM trade_rules", "DELETE FROM trades", "DELETE FROM journal_entries", "DELETE FROM users", "COMMIT"];
    const positions = order.map((s) => sqls.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(s3.deleteObject.mock.calls.map((c) => c[0])).toEqual(["users/7/trades/1/a.png", "users/7/journal/2/b.png"]);
    expect(response.headers["set-cookie"][0]).toMatch(/mnq_session=;/);
  });
});

describe("feedback", () => {
  const sent = [/SELECT name, email FROM users/, { rows: [{ name: "Bro", email: "bob@gmail.com" }] }];

  test("is saved and emailed to the journal inbox", async () => {
    process.env.SMTP_USER = "brotradingjournal@gmail.com";
    const calls = fakeDb([[/count\(\*\)::int AS n FROM feedback/, { rows: [{ n: 0 }] }], sent]);
    const response = await request(app).post("/feedback").set(COOKIE).send({ kind: "bug", message: "Chart <b>broke</b>", page: "/trades/42" });
    expect(response.status).toBe(201);
    expect(calls.find((c) => /INSERT INTO feedback/.test(c.sql)).params.slice(0, 4)).toEqual([7, "bug", "Chart <b>broke</b>", "/trades/42"]);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("brotradingjournal@gmail.com");
    expect(mail.subject).toBe("[MNQ Journal] Bug: Chart <b>broke</b>");
    expect(mail.html).toContain("Chart &lt;b&gt;broke&lt;/b&gt;");
    delete process.env.SMTP_USER;
  });

  test("checks the kind and length", async () => {
    fakeDb([]);
    expect((await request(app).post("/feedback").set(COOKIE).send({ kind: "rant", message: "x" })).status).toBe(400);
    expect((await request(app).post("/feedback").set(COOKIE).send({ kind: "idea", message: "  " })).status).toBe(400);
    expect((await request(app).post("/feedback").set(COOKIE).send({ kind: "idea", message: "x".repeat(2001) })).status).toBe(400);
  });

  test("at most 5 an hour", async () => {
    fakeDb([[/count\(\*\)::int AS n FROM feedback/, { rows: [{ n: 5 }] }], sent]);
    expect((await request(app).post("/feedback").set(COOKIE).send({ kind: "idea", message: "more" })).status).toBe(429);
  });
});
