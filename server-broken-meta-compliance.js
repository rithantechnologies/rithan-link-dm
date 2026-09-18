require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const {
  instagramQueue
} = require("./lib/instagram-queue");

const instagramAuthRouter =
  require("./routes/instagram-auth");

const metaComplianceRouter =
  require("./routes/meta-compliance");

const app = express();

const PORT = process.env.PORT || 3100;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

// Preserve the exact raw request body for
// x-hub-signature-256 validation.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// Existing SaaS OAuth routes.
app.use(
  "/auth/instagram",
  instagramAuthRouter
);

app.use(
  "/meta",
  metaComplianceRouter
);

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Rithan Link DM API",
    mode: "bullmq-multi-tenant"
  });
});

// ---------------------------------------------------------
// Meta webhook verification
// ---------------------------------------------------------

app.get("/webhooks/instagram", (req, res) => {
  const mode =
    req.query["hub.mode"];

  const token =
    req.query["hub.verify_token"];

  const challenge =
    req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log(
      "Instagram webhook verified"
    );

    return res
      .status(200)
      .send(challenge);
  }

  console.log(
    "Instagram webhook verification failed"
  );

  return res.sendStatus(403);
});

// ---------------------------------------------------------
// Meta POST signature validation
// ---------------------------------------------------------

function verifyMetaSignature(req) {
  const signature =
    req.get("x-hub-signature-256");

  if (
    !signature ||
    !APP_SECRET ||
    !req.rawBody
  ) {
    return false;
  }

  const expected =
    "sha256=" +
    crypto
      .createHmac(
        "sha256",
        APP_SECRET
      )
      .update(req.rawBody)
      .digest("hex");

  const actualBuffer =
    Buffer.from(signature);

  const expectedBuffer =
    Buffer.from(expected);

  if (
    actualBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    actualBuffer,
    expectedBuffer
  );
}

// ---------------------------------------------------------
// Meta webhook
//
// The API no longer:
// - queries automations
// - decrypts tokens
// - calls Instagram /messages
//
// It only validates + queues.
// ---------------------------------------------------------

app.post(
  "/webhooks/instagram",
  async (req, res) => {
    if (!verifyMetaSignature(req)) {
      console.log(
        "Invalid Meta webhook signature"
      );

      return res.sendStatus(401);
    }

    try {
      const body = req.body;

      if (
        body.object !== "instagram"
      ) {
        // Valid webhook, but nothing for us to do.
        return res.sendStatus(200);
      }

      let queued = 0;

      for (
        const entry of body.entry || []
      ) {
        const professionalAccountId =
          entry.id
            ? String(entry.id)
            : null;

        if (!professionalAccountId) {
          continue;
        }

        for (
          const change of
          entry.changes || []
        ) {
          if (
            change.field !== "comments"
          ) {
            continue;
          }

          const value =
            change.value || {};

          const commentId =
            value.id
              ? String(value.id)
              : null;

          if (!commentId) {
            console.log(
              "Comment event missing comment ID"
            );

            continue;
          }

          // Using the comment ID as part of the BullMQ
          // job ID gives us queue-level deduplication too.
          const jobId =
            `ig-${commentId}`;

          await instagramQueue.add(
            "instagram-comment",
            {
              professionalAccountId,
              value
            },
            {
              jobId
            }
          );

          queued += 1;

          console.log(
            "Instagram comment queued:",
            {
              jobId,
              professionalAccountId,
              commentId,
              mediaId:
                value.media?.id || null,
              username:
                value.from?.username || null,
              text:
                value.text || ""
            }
          );
        }
      }

      console.log(
        `Webhook acknowledged; queued ${queued} comment job(s)`
      );

      // Return 200 only after Redis has accepted the jobs.
      // If Redis is unavailable, Meta can retry the webhook.
      return res.sendStatus(200);

    } catch (error) {
      console.error(
        "Webhook queueing failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

// ---------------------------------------------------------
// Start API
// ---------------------------------------------------------

app.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      `Rithan Link DM API running on port ${PORT} (BullMQ multi-tenant)`
    );
  }
);

// Graceful shutdown.
async function shutdown(signal) {
  console.log(
    `${signal} received. Closing API...`
  );

  try {
    await instagramQueue.close();
  } catch (error) {
    console.error(
      "Queue close error:",
      error.message
    );
  }

  process.exit(0);
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
