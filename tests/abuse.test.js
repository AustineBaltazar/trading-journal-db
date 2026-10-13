const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
let mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));
const mockS3 = {
  imagesConfigured: () => true,
  uploadUrl: jest.fn(async () => "https://s3.example/upload"),
  viewUrl: jest.fn(async () => "https://s3.example/view"),
  headObject: jest.fn(async () => ({ size: 1000, contentType: "image/png" })),
  deleteObject: jest.fn(async () => ({})),
};
jest.mock("../utils/s3", () => mockS3);

const pool = require("../db");
const app = require("../app");
const { uploadProblem, cleanStaleUploads } = require("../utils/uploads");
const { rowLimitProblem, MAX_ROWS } = require("../utils/limits");
const { removeUnconfirmedAccounts } = require("../utils/housekeeping");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
const MB = 1024 * 1024;

function fakeDb(handlers) {
  const calls = [];
  jest.spyOn(pool, "query").mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, answer] of handlers) {
      if (pattern.test(sql)) return typeof answer === "function" ? answer(params) : answer;
    }
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GLOBAL_STORAGE_LIMIT_GB;
  mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
});

describe("storage", () => {
  const db = (used, pending, site) => ({
    query: async (sql) => {
      if (/FROM pending_uploads WHERE user_id/.test(sql)) return { rows: [{ n: pending }] };
      if (/AS used/.test(sql)) return { rows: [{ used }] };
      return { rows: [{ n: site }] };
    },
  });

  it("uploads still in progress count toward the 200 MB limit", async () => {
    expect(await uploadProblem(db(150 * MB, 0, 0), 12, 5 * MB)).toBeNull();
    expect(await uploadProblem(db(150 * MB, 48 * MB, 0), 12, 5 * MB)).toMatch(/200 MB/);
  });

  it("the whole site has a ceiling too", async () => {
    process.env.GLOBAL_STORAGE_LIMIT_GB = "1";
    expect(await uploadProblem(db(0, 0, 1024 * MB - MB), 12, 5 * MB)).toMatch(/paused/);
  });

  it("asking for an upload link reserves the space; confirming releases it", async () => {
    const calls = fakeDb([
      [/FROM trades WHERE id/, { rows: [{ id: 5 }] }],
      [/count\(\*\)::int AS n FROM trade_images/, { rows: [{ n: 0 }] }],
      [/INSERT INTO trade_images/, { rows: [{ id: 1, caption: null, created_at: new Date() }] }],
    ]);
    const res = await request(app)
      .post("/trades/5/images/upload-url")
      .set(COOKIE)
      .send({ content_type: "image/png", size_bytes: 2048 });
    expect(res.status).toBe(200);
    const reserve = calls.find((c) => /INSERT INTO pending_uploads/.test(c.sql));
    expect(reserve.params).toEqual([res.body.key, 12, 2048]);

    const done = await request(app).post("/trades/5/images").set(COOKIE).send({ key: res.body.key });
    expect(done.status).toBe(201);
    expect(calls.some((c) => /DELETE FROM pending_uploads/.test(c.sql) && c.params[0] === res.body.key)).toBe(true);
  });

  it("unfinished uploads are deleted from S3 after a while", async () => {
    const queries = [];
    const db = {
      query: async (sql, params) => {
        queries.push(sql);
        if (/SELECT s3_key FROM pending_uploads/.test(sql)) {
          expect(params).toEqual([30]);
          return { rows: [{ s3_key: "users/12/a.png" }, { s3_key: "users/12/b.png" }] };
        }
        return { rows: [] };
      },
    };
    expect(await cleanStaleUploads(db, mockS3)).toBe(2);
    expect(mockS3.deleteObject).toHaveBeenCalledWith("users/12/a.png");
    expect(queries.filter((q) => /DELETE FROM pending_uploads/.test(q))).toHaveLength(2);
  });
});

describe("limits per account", () => {
  it("caps how many rows of each kind an account can create", async () => {
    const db = (n) => ({ query: async () => ({ rows: [{ n }] }) });
    expect(await rowLimitProblem(db(MAX_ROWS.trades.limit - 1), "trades", 12)).toBeNull();
    expect(await rowLimitProblem(db(MAX_ROWS.trades.limit), "trades", 12)).toBe(
      "You've reached the limit of 20,000 trades.",
    );
  });

  it("a new trade past the limit is refused before anything is saved", async () => {
    const calls = fakeDb([[/count\(\*\)::int AS n FROM trades/, { rows: [{ n: 20000 }] }]]);
    const res = await request(app).post("/trades").set(COOKIE).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20,000 trades/);
    expect(calls.some((c) => /INSERT INTO trades/.test(c.sql))).toBe(false);
  });

  it("saving an existing journal day doesn't count as a new one", async () => {
    const calls = fakeDb([[/SELECT 1 FROM journal_entries/, { rows: [{ "?column?": 1 }] }]]);
    await request(app).put("/journal/2026-10-01").set(COOKIE).send({ plan: "x" });
    expect(calls.some((c) => /count\(\*\)::int AS n FROM journal_entries/.test(c.sql))).toBe(false);
  });

  it("too many saves in 10 minutes are slowed down, per account", async () => {
    mockSession = { id: "9", user_id: 777, email: "bot@gmail.com" };
    fakeDb([[/count\(\*\)/, { rows: [{ n: 0 }] }]]);
    let last;
    for (let i = 0; i < 301; i++) last = await request(app).delete("/rules/1").set(COOKIE);
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/saving very fast/);
    // someone else is unaffected
    mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
    expect((await request(app).delete("/rules/1").set(COOKIE)).status).not.toBe(429);
  });

  it("upload links are limited to 60 an hour per account", async () => {
    mockSession = { id: "8", user_id: 778, email: "uploader@gmail.com" };
    fakeDb([
      [/FROM trades WHERE id/, { rows: [{ id: 5 }] }],
      [/count\(\*\)::int AS n FROM trade_images/, { rows: [{ n: 0 }] }],
    ]);
    let last;
    for (let i = 0; i < 61; i++) {
      last = await request(app)
        .post("/trades/5/images/upload-url")
        .set(COOKIE)
        .send({ content_type: "image/png", size_bytes: 10 });
    }
    expect(last.status).toBe(429);
  });
});

describe("unconfirmed sign-ups", () => {
  it("removes week-old unconfirmed accounts with no data, in one transaction", async () => {
    const sqls = [];
    const client = {
      query: async (sql, params) => {
        sqls.push(sql);
        if (/SELECT id, email FROM users/.test(sql)) {
          expect(sql).toMatch(/email_verified_at IS NULL AND google_sub IS NULL/);
          expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM trades/);
          expect(params).toEqual([7]);
          return { rows: [{ id: 40, email: "bot1@x.com" }, { id: 41, email: "bot2@x.com" }] };
        }
        return { rows: [] };
      },
      release: jest.fn(),
    };
    const fakePool = { connect: async () => client };
    expect(await removeUnconfirmedAccounts(fakePool)).toBe(2);
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(sqls.some((s) => /DELETE FROM users WHERE id = ANY/.test(s))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
