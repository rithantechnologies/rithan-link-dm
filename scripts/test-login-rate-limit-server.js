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

app.listen(
  3194,
  "127.0.0.1",
  () => {
    console.log(
      "Login rate-limit test ready on 127.0.0.1:3194"
    );
  }
);
