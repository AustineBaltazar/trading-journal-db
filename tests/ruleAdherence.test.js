const request = require("supertest");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const pool = require("../db");
const app = require("../app");
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ id: 7 }, process.env.JWT_SECRET)}` });

afterEach(() => jest.restoreAllMocks());

test("passes the optional date range to both queries", async () => {
  const query = jest.spyOn(pool, "query").mockResolvedValue({ rows: [] });
  const res = await request(app).get("/rule-adherence?mode=live&from=2026-09-01&to=2026-09-30").set(auth());
  expect(res.status).toBe(200);
  expect(query).toHaveBeenCalledTimes(2);
  for (const [sql, params] of query.mock.calls) {
    expect(sql).toContain("trades.trade_date >= $3");
    expect(params).toEqual([7, "live", "2026-09-01", "2026-09-30"]);
  }
});

test("no range means all time", async () => {
  const query = jest.spyOn(pool, "query").mockResolvedValue({ rows: [] });
  await request(app).get("/rule-adherence?mode=backtest").set(auth());
  expect(query.mock.calls[0][1]).toEqual([7, "backtest", null, null]);
});

test("rejects a date that doesn't exist", async () => {
  const query = jest.spyOn(pool, "query");
  const res = await request(app).get("/rule-adherence?from=2026-09-31").set(auth());
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/^from must be a date/);
  expect(query).not.toHaveBeenCalled();
});
