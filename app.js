const express = require("express");
const app = express();
const cors = require("cors");
app.use(express.json());
app.use(cors());

const authRoutes = require("./routes/auth");
const tradesRoutes = require("./routes/trades");
const rulesRoutes = require("./routes/rules");
const questionsRoutes = require("./routes/questions");
const tradeRulesRoutes = require("./routes/tradeRules");
const tradeAnswersRoutes = require("./routes/tradeAnswers");
const mistakesRoutes = require("./routes/mistakes");
const journalRoutes = require("./routes/journal");
const tradeImagesRoutes = require("./routes/tradeImages");

app.get("/", (req, res) => {
  res.send("My trading journal API is running!");
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

module.exports = app;
