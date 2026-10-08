const request = require("supertest");
const pool = require("../db");
const app = require("../app");

afterEach(() => jest.restoreAllMocks());

test("GET /health is ok when the database answers", async () => {
  jest.spyOn(pool, "query").mockResolvedValue({ rows: [{ "?column?": 1 }] });
  const response = await request(app).get("/health");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: "ok", database: "ok" });
});

test("GET /health is 503 when the database is down", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(pool, "query").mockRejectedValue(new Error("connect ECONNREFUSED"));
  const response = await request(app).get("/health");
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ status: "down", database: "unreachable" });
});

test("GET /health is 503 when the database hangs", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(pool, "query").mockReturnValue(new Promise(() => {}));
  const started = Date.now();
  const response = await request(app).get("/health");
  expect(response.status).toBe(503);
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
}, 6000);
