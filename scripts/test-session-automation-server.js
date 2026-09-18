require("dotenv").config();

const express = require("express");

const authRouter =
  require("../routes/auth");

const automationsRouter =
  require("../routes/automations-session");

const app = express();

app.use(express.json());

app.use(
  "/api/auth",
  authRouter
);

app.use(
  "/api/automations",
  automationsRouter
);

app.get("/", (req, res) => {
  res.json({
    status: "session-automation-test-ok"
  });
});

app.listen(
  3196,
  "127.0.0.1",
  () => {
    console.log(
      "Session automation test server ready on 127.0.0.1:3196"
    );
  }
);
