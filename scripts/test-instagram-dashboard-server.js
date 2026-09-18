require("dotenv").config();

const express = require("express");

const authRouter =
  require("../routes/auth");

const instagramDashboardRouter =
  require("../routes/instagram-dashboard");

const app = express();

app.use(express.json());

app.use(
  "/api/auth",
  authRouter
);

app.use(
  "/api/instagram",
  instagramDashboardRouter
);

app.listen(
  3195,
  "127.0.0.1",
  () => {
    console.log(
      "Instagram dashboard test server ready on 127.0.0.1:3195"
    );
  }
);
