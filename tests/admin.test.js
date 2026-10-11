const request = require("supertest");

jest.mock("../utils/mailer", () => ({ sendMail: jest.fn(async () => true), RESERVED: /$^/ }));
let mockSession = { id: "3", user_id: 12, email: "brotradingjournal@gmail.com" };
jest.mock("../utils/sessions", () => ({
  ...jest.requireActual("../utils/sessions"),
  findSession: jest.fn(async () => mockSession),
}));

const pool = require("../db");
const app = require("../app");
const { isAdmin } = require("../utils/account");

const COOKIE = { Cookie: "mnq_session=test-session-token-0123456789" };
afterEach(() => {
  jest.restoreAllMocks();
  mockSession = { id: "3", user_id: 12, email: "brotradingjournal@gmail.com" };
  delete process.env.ADMIN_EMAILS;
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
  return calls;
}

const inbox = (total = 23) => [
  [/SELECT count\(\*\) FROM feedback f/, { rows: [{ count: String(total) }] }],
  [
    /FROM feedback f LEFT JOIN users u[\s\S]*ORDER BY/,
    {
      rows: [
        {
          id: "5",
          kind: "bug",
          message: "Screenshot won't upload",
          page: "/trades/512",
          user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
          status: "new",
          admin_note: null,
          created_at: new Date(),
          user_id: 15,
          name: "Andrei",
          email: "andrei@gmail.com",
          joined: new Date(),
          trades: 50,
        },
      ],
    },
  ],
  [/AS "thisWeek"/, { rows: [{ all: 23, new: 3, working: 2, done: 18, bug: 5, idea: 8, other: 10, thisWeek: 6 }] }],
  [/AS "newThisWeek"/, { rows: [{ total: 17, newThisWeek: 4 }] }],
];

test("admins come from ADMIN_EMAILS, default brotradingjournal@gmail.com", () => {
  expect(isAdmin("BroTradingJournal@gmail.com")).toBe(true);
  expect(isAdmin("someone@gmail.com")).toBe(false);
  process.env.ADMIN_EMAILS = "a@x.com, b@y.com";
  expect(isAdmin("b@y.com")).toBe(true);
  expect(isAdmin("brotradingjournal@gmail.com")).toBe(false);
});

test("anyone else gets 'not found' for every admin route", async () => {
  mockSession = { id: "4", user_id: 15, email: "andrei@gmail.com" };
  const calls = fakeDb([]);
  expect((await request(app).get("/admin/feedback").set(COOKIE)).status).toBe(404);
  expect((await request(app).get("/admin/feedback/new-count").set(COOKIE)).status).toBe(404);
  expect((await request(app).patch("/admin/feedback/5").set(COOKIE).send({ status: "done" })).status).toBe(404);
  expect(calls.some((c) => /feedback/.test(c.sql))).toBe(false);
  expect((await request(app).get("/admin/feedback")).status).toBe(401); // logged out
});

test("the inbox: one page, with device, user and counts", async () => {
  fakeDb(inbox());
  const { body } = await request(app).get("/admin/feedback?page=2").set(COOKIE);
  expect(body).toMatchObject({ total: 23, page: 2, pageSize: 8, pages: 3, counts: { new: 3 }, users: { total: 17 } });
  expect(body.items[0]).toMatchObject({
    id: 5,
    kind: "bug",
    device: "Safari on iPhone",
    status: "new",
    user: { name: "Andrei", email: "andrei@gmail.com", trades: 50 },
  });
});

test("page numbers are kept in range and LIMIT/OFFSET follow them", async () => {
  const calls = fakeDb(inbox(23));
  const { body } = await request(app).get("/admin/feedback?page=99&pageSize=10").set(COOKIE);
  expect(body.page).toBe(3);
  expect(calls.find((c) => /ORDER BY/.test(c.sql)).sql).toMatch(/LIMIT 10 OFFSET 20/);
  fakeDb(inbox(0));
  expect((await request(app).get("/admin/feedback?page=-4&pageSize=999").set(COOKIE)).body).toMatchObject({ page: 1, pageSize: 8, pages: 1 });
});

test("filters and search go into the query safely", async () => {
  const calls = fakeDb(inbox());
  await request(app).get("/admin/feedback?status=new&kind=idea&q=50%_off").set(COOKIE);
  const count = calls.find((c) => /SELECT count\(\*\) FROM feedback f/.test(c.sql));
  expect(count.sql).toMatch(/f\.status = \$1 AND f\.kind = \$2 AND \(f\.message ILIKE \$3 OR u\.email ILIKE \$3\)/);
  expect(count.params).toEqual(["new", "idea", "%50\\%\\_off%"]);
  const ignored = fakeDb(inbox());
  await request(app).get("/admin/feedback?status=hacked&kind=x").set(COOKIE);
  expect(ignored[0].sql).not.toMatch(/WHERE/);
});

test("status and note can be changed", async () => {
  const calls = fakeDb([[/UPDATE feedback SET/, { rows: [{ id: "5", status: "working", admin_note: "Asked for the file size" }] }]]);
  const response = await request(app).patch("/admin/feedback/5").set(COOKIE).send({ status: "working", note: " Asked for the file size " });
  expect(response.body).toEqual({ id: 5, status: "working", note: "Asked for the file size" });
  expect(calls[calls.length - 1].params).toEqual(["working", "Asked for the file size", 5]);
  fakeDb([]);
  expect((await request(app).patch("/admin/feedback/5").set(COOKIE).send({ status: "deleted" })).status).toBe(400);
  expect((await request(app).patch("/admin/feedback/5").set(COOKIE).send({})).status).toBe(400);
  expect((await request(app).patch("/admin/feedback/99").set(COOKIE).send({ status: "done" })).status).toBe(404);
});

test("the admin flag shows on /me only for admins", async () => {
  fakeDb([[/FROM users WHERE id/, { rows: [{ id: 12, name: "MNQ", email: "brotradingjournal@gmail.com" }] }]]);
  expect((await request(app).get("/me").set(COOKIE)).body.user.admin).toBe(true);
  mockSession = { id: "4", user_id: 15, email: "andrei@gmail.com" };
  fakeDb([[/FROM users WHERE id/, { rows: [{ id: 15, name: "A", email: "andrei@gmail.com" }] }]]);
  expect((await request(app).get("/me").set(COOKIE)).body.user.admin).toBeUndefined();
});
