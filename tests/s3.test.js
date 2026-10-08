const { S3Client } = require("@aws-sdk/client-s3");
const { headObject } = require("../utils/s3");

const s3Error = (status, name = "Error") => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

afterEach(() => jest.restoreAllMocks());

describe("headObject", () => {
  test("returns size and type when the object exists", async () => {
    jest.spyOn(S3Client.prototype, "send").mockResolvedValue({ ContentLength: 69, ContentType: "image/png" });
    await expect(headObject("users/1/trades/2/a.png")).resolves.toEqual({ size: 69, contentType: "image/png" });
  });

  test.each([
    ["404 Not Found", s3Error(404, "NotFound")],
    ["403 without ListBucket permission", s3Error(403, "Forbidden")],
  ])("treats %s as missing", async (_, err) => {
    jest.spyOn(S3Client.prototype, "send").mockRejectedValue(err);
    await expect(headObject("users/1/trades/2/a.png")).resolves.toBeNull();
  });

  test("still throws other errors", async () => {
    jest.spyOn(S3Client.prototype, "send").mockRejectedValue(s3Error(500, "InternalError"));
    await expect(headObject("users/1/trades/2/a.png")).rejects.toThrow("InternalError");
  });
});
