const { googleEnabled, verifyGoogleCredential } = require("../utils/google");

afterEach(() => delete process.env.GOOGLE_CLIENT_ID);

test("off without GOOGLE_CLIENT_ID", async () => {
  expect(googleEnabled()).toBe(false);
  expect(await verifyGoogleCredential("anything")).toBeNull();
});

test("empty or oversized tokens are refused without asking Google", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  expect(await verifyGoogleCredential("")).toBeNull();
  expect(await verifyGoogleCredential(undefined)).toBeNull();
  expect(await verifyGoogleCredential("x".repeat(5000))).toBeNull();
});
