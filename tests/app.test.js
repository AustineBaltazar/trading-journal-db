const request = require("supertest");
const app = require("../app");

test("GET / should return a running message", async () => {
  const response = await request(app).get("/");
  expect(response.status).toBe(200);
});
