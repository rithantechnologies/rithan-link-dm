require("dotenv").config();

const express = require("express");

const authRouter =
  require("../routes/auth");

const app = express();

app.use(express.json());

app.use(
  "/api/auth",
  authRouter
);

app.get("/", (req, res) => {
  res.json({
    status: "auth-test-ok"
  });
});

app.listen(
  3197,
  "127.0.0.1",
  () => {
    console.log(
      "Auth test server ready on 127.0.0.1:3197"
    );
  }
);
