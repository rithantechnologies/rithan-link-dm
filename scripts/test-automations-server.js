require("dotenv").config();

const express = require("express");

const automationsRouter =
  require("../routes/automations");

const app = express();

app.use(express.json());

app.use(
  "/api/automations",
  automationsRouter
);

app.get("/", (req, res) => {
  res.json({
    status: "automation-test-ok"
  });
});

app.listen(
  3198,
  "127.0.0.1",
  () => {
    console.log(
      "Automation CRUD test server ready on 127.0.0.1:3198"
    );
  }
);
