const express = require("express");
const app = express();
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");

// Pages that may call the API with the login cookie
const allowedOrigins = (process.env.APP_ORIGINS || "http://localhost:4200,http://localhost:4300")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Nginx on the same host passes the visitor's IP in X-Forwarded-For
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, uniquelocal");
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Writes from another site are refused (the SameSite cookie already blocks most)
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !origin || allowedOrigins.includes(origin)) {
    return next();
  }
  res.status(403).json({ error: "Request blocked." });
});

const authRoutes = require("./routes/auth");
const tradesRoutes = require("./routes/trades");
const rulesRoutes = require("./routes/rules");
const questionsRoutes = require("./routes/questions");
const tradeRulesRoutes = require("./routes/tradeRules");
const tradeAnswersRoutes = require("./routes/tradeAnswers");
const mistakesRoutes = require("./routes/mistakes");
const journalRoutes = require("./routes/journal");
const tradeImagesRoutes = require("./routes/tradeImages");
const tagsRoutes = require("./routes/tags");

app.get("/", (req, res) => {
  res.send("My trading journal API is running!");
});

// For uptime monitoring: up only if the database answers within 3 seconds
const pool = require("./db");
app.get("/health", async (req, res) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("database timeout")), 3000);
  });
  try {
    await Promise.race([pool.query("SELECT 1"), timeout]);
    res.json({ status: "ok", database: "ok" });
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.status(503).json({ status: "down", database: "unreachable" });
  } finally {
    clearTimeout(timer);
  }
});

app.use("/", authRoutes);
app.use("/trades", tradesRoutes);
app.use("/rules", rulesRoutes);
app.use("/questions", questionsRoutes);
app.use("/", tradeRulesRoutes);
app.use("/", tradeAnswersRoutes);
app.use("/", mistakesRoutes);
app.use("/", journalRoutes);
app.use("/", tradeImagesRoutes);
app.use("/", tagsRoutes);

module.exports = app;
