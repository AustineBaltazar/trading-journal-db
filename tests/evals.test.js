const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
let mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));

const pool = require("../db");
const app = require("../app");
const { parseRules } = require("../routes/evals");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
afterEach(() => {
  jest.restoreAllMocks();
  mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
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
  jest.spyOn(pool, "connect").mockImplementation(async () => ({ query, release: jest.fn() }));
  return calls;
}

const row = (extra = {}) => ({
  id: "4",
  name: "Tradeify Growth 25K",
  account_size: "25000.00",
  profit_target: "1500.00",
  max_drawdown: "1000.00",
  drawdown_type: "eod_trailing",
  daily_loss_limit: "600.00",
  min_days: null,
  consistency_pct: null,
  started_on: "2026-10-13",
  ended_on: null,
  result: null,
  fail_reason: null,
  ...extra,
});

const GROWTH = {
  name: "Tradeify Growth 25K",
  accountSize: 25000,
  profitTarget: 1500,
  maxDrawdown: 1000,
  drawdownType: "eod_trailing",
  dailyLossLimit: 600,
};

test("rules: required name and size, empty rules are off, bad values refused", () => {
  expect(parseRules({ ...GROWTH, minDays: "", consistencyPct: null }).values).toMatchObject({
    accountSize: 25000,
    dailyLossLimit: 600,
    minDays: null,
    consistencyPct: null,
  });
  expect(parseRules({ ...GROWTH, name: " " }).error).toMatch(/name/);
  expect(parseRules({ ...GROWTH, accountSize: "" }).error).toMatch(/Account size is required/);
  expect(parseRules({ ...GROWTH, maxDrawdown: -5 }).error).toMatch(/positive/);
  expect(parseRules({ ...GROWTH, consistencyPct: 5 }).error).toMatch(/10 to 100/);
  expect(parseRules({ ...GROWTH, drawdownType: "weird" }).error).toMatch(/drawdown type/);
  expect(parseRules({ ...GROWTH, startedOn: "13/10/2026" }).error).toMatch(/YYYY-MM-DD/);
});

test("eval is a mode for trades", async () => {
  const calls = fakeDb([[/FROM trades/, { rows: [] }]]);
  expect((await request(app).get("/trades?mode=eval").set(COOKIE)).status).toBe(200);
  expect(calls[0].params).toEqual([12, "eval"]);
  expect((await request(app).get("/trades?mode=paper").set(COOKIE)).status).toBe(400);
});

test("lists attempts with the open one as current, numbers as numbers", async () => {
  fakeDb([[/FROM eval_attempts/, { rows: [row(), row({ id: "2", ended_on: "2026-10-09", result: "failed", fail_reason: "Daily loss" })] }]]);
  const { body } = await request(app).get("/evals").set(COOKIE);
  expect(body.current).toMatchObject({ id: 4, accountSize: 25000, dailyLossLimit: 600, minDays: null });
  expect(body.attempts[1]).toMatchObject({ id: 2, result: "failed", failReason: "Daily loss" });
});

test("starts one evaluation; a second open one is refused", async () => {
  const calls = fakeDb([[/INSERT INTO eval_attempts/, { rows: [row()] }]]);
  const res = await request(app).post("/evals").set(COOKIE).send(GROWTH);
  expect(res.status).toBe(201);
  expect(calls[0].params.slice(0, 4)).toEqual([12, "Tradeify Growth 25K", 25000, 1500]);

  jest.restoreAllMocks();
  fakeDb([[/INSERT INTO eval_attempts/, () => { throw Object.assign(new Error("dup"), { code: "23505" }); }]]);
  expect((await request(app).post("/evals").set(COOKIE).send(GROWTH)).status).toBe(409);
});

test("ending an attempt can start the next one with the same rules", async () => {
  const calls = fakeDb([
    [/UPDATE eval_attempts SET ended_on/, { rows: [row({ ended_on: "2026-10-17", result: "failed", fail_reason: "Daily loss" })] }],
    [/INSERT INTO eval_attempts[\s\S]*SELECT/, { rows: [row({ id: "5", started_on: "2026-10-17" })] }],
  ]);
  const { status, body } = await request(app)
    .post("/evals/4/end")
    .set(COOKIE)
    .send({ result: "failed", reason: "Daily loss", startNext: true });
  expect(status).toBe(200);
  expect(body.ended).toMatchObject({ result: "failed", endedOn: "2026-10-17" });
  expect(body.next).toMatchObject({ id: 5, startedOn: "2026-10-17" });
  expect(calls.map((c) => c.sql.trim().split(/\s+/)[0])).toEqual(["BEGIN", "UPDATE", "INSERT", "COMMIT"]);

  jest.restoreAllMocks();
  fakeDb([]);
  expect((await request(app).post("/evals/4/end").set(COOKIE).send({ result: "maybe" })).status).toBe(400);
  expect((await request(app).post("/evals/4/end").set(COOKIE).send({ result: "passed" })).status).toBe(404);
});

test("only your own attempts can be changed or deleted", async () => {
  const calls = fakeDb([]);
  expect((await request(app).put("/evals/4").set(COOKIE).send(GROWTH)).status).toBe(404);
  expect((await request(app).delete("/evals/4").set(COOKIE)).status).toBe(404);
  expect(calls.every((c) => c.params.includes(12))).toBe(true);
});

test("the demo account can't change evaluations", async () => {
  mockSession = { id: "9", user_id: 7, email: "giyotest@example.com" };
  fakeDb([]);
  expect((await request(app).post("/evals").set(COOKIE).send(GROWTH)).status).toBe(403);
});
