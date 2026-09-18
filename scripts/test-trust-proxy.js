const express = require("express");

const app = express();

app.set(
  "trust proxy",
  "loopback"
);

app.get(
  "/ip",
  (req, res) => {
    res.json({
      ip: req.ip,
      ips: req.ips,
      forwardedFor:
        req.get(
          "x-forwarded-for"
        ) || null
    });
  }
);

app.listen(
  3193,
  "127.0.0.1",
  () => {
    console.log(
      "Trust proxy test ready on 127.0.0.1:3193"
    );
  }
);
