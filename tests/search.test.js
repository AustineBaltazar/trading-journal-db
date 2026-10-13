const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
let mockSession = { id: "3", user_id: 12, email: "trader@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));

const pool = require("../db");
const app = require("../app");
const { snippet } = require("../routes/search");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
afterEach(() => jest.restoreAllMocks());

const trade = (id, date, notes, exit, extra = {}) => ({
  id,
  user_id: 12,
  trade_date: date,
  symbol: "MNQ",
  direction: "long",
  contracts: 1,
  entry_price: "20000",
  exit_price: String(exit),
  fees: "0",
  strategy: "IFVG reclaim",
  notes,
  entry_time: "10:00",
  mode: "live",
  result: null,
  stop_price: null,
  target_price: null,
  ...extra,
});

function fakeDb({ matched = [], all = [], entries = [], tradeCaptions = [], journalCaptions = [] }) {
  const calls = [];
  jest.spyOn(pool, "query").mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM trade_images i JOIN trades/.test(sql)) return { rows: tradeCaptions };
    if (/FROM journal_images i JOIN journal_entries/.test(sql)) return { rows: journalCaptions };
    if (/FROM journal_entries/.test(sql)) return { rows: entries };
    if (/FROM trades\s+WHERE[\s\S]*ILIKE/.test(sql)) return { rows: matched };
    if (/FROM trades WHERE/.test(sql)) return { rows: all };
    return { rows: [] };
  });
  return calls;
}

test("snippet keeps the word in view", () => {
  expect(snippet("short note about being tired", "tired")).toBe("short note about being tired");
  const long = "a".repeat(200) + " tired " + "b".repeat(200);
  const s = snippet(long, "TIRED");
  expect(s.startsWith("…")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s).toContain("tired");
});

test("needs a login and at least 2 characters", async () => {
  fakeDb({});
  expect((await request(app).get("/search?q=tired")).status).toBe(401);
  expect((await request(app).get("/search?q=t").set(COOKIE)).status).toBe(400);
  expect((await request(app).get("/search?q=tired&mode=paper").set(COOKIE)).status).toBe(400);
  expect((await request(app).get("/search?q=tired&from=nope").set(COOKIE)).status).toBe(400);
});

test("finds trades and journal days, with stats next to every trade", async () => {
  const tired = trade(1, "2026-09-19", "Was tired after a bad night", 19990); // -$20 (10 pts × $2)
  const calls = fakeDb({
    matched: [tired],
    all: [tired, trade(2, "2026-09-20", "fine", 20050), trade(3, "2026-09-21", null, 20025)],
    entries: [
      {
        id: 7,
        date: "2026-09-19",
        to_fix: "Don't trade when I'm TIRED.",
        lesson: null,
        plan: "One setup only, tired",
        key_levels: [{ price: 20100, label: "tired high" }],
      },
    ],
    journalCaptions: [{ entry_id: 7, section: "pre", caption: "Tired chart" }],
  });
  const { status, body } = await request(app).get("/search?q=tired&from=2026-09-01").set(COOKIE);
  expect(status).toBe(200);
  expect(body.trades).toEqual([
    expect.objectContaining({ type: "trade", id: 1, field: "Notes", outcome: "loss", netPnl: -20 }),
  ]);
  expect(body.journal.map((j) => j.field)).toEqual(["Plan", "What to fix", "Key level", "Pre-market chart"]);
  expect(body.journal[0]).toMatchObject({ date: "2026-09-19", dayNet: -20 });
  expect(body.stats.matched).toMatchObject({ totalTrades: 1, winRate: 0, totalPnl: -20 });
  expect(body.stats.overall).toMatchObject({ totalTrades: 3, wins: 2, losses: 1 });
  // the search is the user's own, in their mode, and % _ are literal
  const search = calls.find((c) => /ILIKE \$5/.test(c.sql) && /FROM trades/.test(c.sql));
  expect(search.params).toEqual([12, "live", "2026-09-01", null, "%tired%"]);
});

test("% and _ in the search are not wildcards", async () => {
  const calls = fakeDb({});
  await request(app).get("/search?q=50%25_off").set(COOKIE);
  expect(calls[0].params[4]).toBe("%50\\%\\_off%");
});

test("a trade found by its screenshot caption says so", async () => {
  fakeDb({
    matched: [trade(4, "2026-09-02", "nothing here", 20010)],
    tradeCaptions: [{ trade_id: 4, caption: "tired entry, see wick" }],
  });
  const { body } = await request(app).get("/search?q=tired").set(COOKIE);
  expect(body.trades[0]).toMatchObject({ field: "Screenshot caption", snippet: "tired entry, see wick" });
});
