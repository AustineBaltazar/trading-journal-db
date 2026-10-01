const express = require("express");
const app = express();
const cors = require("cors");
app.use(express.json());
app.use(cors());
const PORT = 3001;

const authRoutes = require("./routes/auth");
const tradesRoutes = require("./routes/trades");
const rulesRoutes = require("./routes/rules");
const questionsRoutes = require("./routes/questions");
const tradeRulesRoutes = require("./routes/tradeRules");
const tradeAnswersRoutes = require("./routes/tradeAnswers");

app.get("/", (req, res) => {
  res.send("My trading journal API is running!");
});

app.use("/", authRoutes);
app.use("/trades", tradesRoutes);
app.use("/rules", rulesRoutes);
app.use("/questions", questionsRoutes);
app.use("/", tradeRulesRoutes);
app.use("/", tradeAnswersRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
