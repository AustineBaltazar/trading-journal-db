const {
  parseEntryDate,
  parseMonth,
  parseEntryFields,
  parseImageRequest,
  userImagePrefix,
} = require("../utils/journal");

describe("parseEntryDate", () => {
  test("accepts real dates only", () => {
    expect(parseEntryDate("2026-09-23")).toBe("2026-09-23");
    expect(parseEntryDate("2024-02-29")).toBe("2024-02-29");
    expect(parseEntryDate("2026-02-30")).toBeNull();
    expect(parseEntryDate("2026-9-23")).toBeNull();
    expect(parseEntryDate(undefined)).toBeNull();
  });
});

describe("parseMonth", () => {
  test("returns the first and last day", () => {
    expect(parseMonth("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(parseMonth("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(parseMonth("2026-13")).toBeNull();
  });
});

describe("parseEntryFields", () => {
  test("returns only the fields that were sent", () => {
    expect(parseEntryFields({ plan: "  Longs only  " })).toEqual({ values: { plan: "Longs only" } });
    expect(parseEntryFields({})).toEqual({ values: {} });
  });

  test("blank clears a field", () => {
    expect(parseEntryFields({ bias: "", lesson: null })).toEqual({ values: { bias: null, lesson: null } });
  });

  test("checks choices", () => {
    expect(parseEntryFields({ bias: "bullish", mood: "Bored", day_grade: "D", followed_plan: "no" }).values)
      .toEqual({ bias: "bullish", mood: "Bored", day_grade: "D", followed_plan: "no" });
    expect(parseEntryFields({ bias: "up" }).error).toMatch(/^bias must be one of/);
    expect(parseEntryFields({ day_grade: "A+" }).error).toMatch(/^day_grade/);
  });

  test("cleans key levels", () => {
    expect(parseEntryFields({ key_levels: [{ price: "21466.5", label: " IFVG " }] }).values)
      .toEqual({ key_levels: [{ price: 21466.5, label: "IFVG" }] });
    expect(parseEntryFields({ key_levels: [{ label: "no price" }] }).error).toBeDefined();
    expect(parseEntryFields({ key_levels: "21466" }).error).toBeDefined();
    expect(parseEntryFields({ key_levels: Array(11).fill({ price: 1 }) }).error).toBeDefined();
  });

  test("rejects very long text", () => {
    expect(parseEntryFields({ plan: "x".repeat(2001) }).error).toBeDefined();
  });
});

describe("parseImageRequest", () => {
  test("accepts PNG, JPG and WebP up to 5 MB", () => {
    expect(parseImageRequest({ section: "pre", content_type: "image/png", size_bytes: 1000 }))
      .toEqual({ section: "pre", contentType: "image/png", size: 1000, ext: "png" });
    expect(parseImageRequest({ section: "post", content_type: "image/jpeg", size_bytes: 5 * 1024 * 1024 }).ext)
      .toBe("jpg");
  });

  test.each([
    [{ section: "mid", content_type: "image/png", size_bytes: 1 }],
    [{ section: "pre", content_type: "image/gif", size_bytes: 1 }],
    [{ section: "pre", content_type: "image/svg+xml", size_bytes: 1 }],
    [{ section: "pre", content_type: "image/png", size_bytes: 5 * 1024 * 1024 + 1 }],
    [{ section: "pre", content_type: "image/png" }],
  ])("rejects %p", (body) => {
    expect(parseImageRequest(body).error).toBeDefined();
  });
});

test("image keys live under the owner's prefix", () => {
  expect(userImagePrefix(11)).toBe("users/11/journal/");
});
