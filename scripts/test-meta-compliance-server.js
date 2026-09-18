require("dotenv").config();

const express = require("express");

const metaComplianceRouter =
  require("../routes/meta-compliance");

const app = express();

app.use(
  "/meta",
  metaComplianceRouter
);

app.get("/", (req, res) => {
  res.json({
    status: "test-ok"
  });
});

app.listen(
  3199,
  "127.0.0.1",
  () => {
    console.log(
      "Meta compliance test server ready on 127.0.0.1:3199"
    );
  }
);
