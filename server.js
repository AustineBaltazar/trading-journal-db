const app = require("./app");
const pool = require("./db");
const s3 = require("./utils/s3");
const { startHousekeeping } = require("./utils/housekeeping");
const PORT = 3001;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  // Every 15 minutes: delete unfinished uploads and week-old unconfirmed sign-ups
  startHousekeeping(pool, s3);
});
