require("dotenv").config();

const express = require("express");
const crypto = require("crypto");

const {
  instagramQueue,
  closeInstagramQueue
} = require("./lib/instagram-queue");

const pool =
  require("./db");

const {
  createRedisConnection
} = require("./lib/redis");

const readinessRedis =
  createRedisConnection();

const instagramAuthRouter =
  require("./routes/instagram-auth");

const automationsRouter =
  require("./routes/automations");

const authRouter =
  require("./routes/auth");

const instagramAccountsRouter =
  require("./routes/instagram-accounts");

const activityRouter =
  require("./routes/activity");

const analyticsRouter =
  require("./routes/analytics");

const billingRouter =
  require("./routes/billing");

const adminRouter =
  require("./routes/admin");

const settingsRouter =
  require("./routes/settings");

const {
  requestObservability
} = require("./lib/observability");

const metaComplianceRouter =
  require("./routes/meta-compliance");

const {
  apiMutationRateLimit,
  closeApiMutationRateLimiter
} = require("./lib/api-mutation-rate-limit");

const {
  closeLoginRateLimiter
} = require("./lib/login-rate-limit");

const app = express();

// --------------------------------------------------
// Basic HTTP security hardening
// --------------------------------------------------

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    "DENY"
  );

  res.setHeader(
    "Referrer-Policy",
    "strict-origin-when-cross-origin"
  );

  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  res.setHeader(
    "Cross-Origin-Opener-Policy",
    "same-origin"
  );

  res.setHeader(
    "X-DNS-Prefetch-Control",
    "off"
  );

  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "form-action 'self'"
    ].join("; ")
  );

  if (
    req.secure ||
    req.get("x-forwarded-proto") === "https"
  ) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000"
    );
  }

  next();
});

// Trust only the local Nginx reverse proxy.
// This allows req.ip to resolve the real visitor IP
// from X-Forwarded-For without trusting arbitrary proxies.
app.set("trust proxy", "loopback");

app.use(requestObservability);

const PORT = process.env.PORT || 3100;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

// Preserve the exact raw request body for
// x-hub-signature-256 validation.
app.use(
  express.json({
    limit:
      process.env.JSON_BODY_LIMIT ||
      "512kb",

    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

app.use((error, req, res, next) => {
  if (
    error?.type ===
    "entity.too.large"
  ) {
    return res.status(413).json({
      error:
        "request_body_too_large"
    });
  }

  if (
    error instanceof SyntaxError &&
    error?.type ===
      "entity.parse.failed"
  ) {
    return res.status(400).json({
      error:
        "invalid_json"
    });
  }

  return next(error);
});

app.use(
  "/api",
  (req, res, next) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    next();
  }
);

app.use(
  "/api",
  apiMutationRateLimit
);

// Existing SaaS OAuth routes.
app.use(
  "/auth/instagram",
  (req, res, next) => {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    next();
  },
  instagramAuthRouter
);

app.use(
  "/api/auth",
  authRouter
);

app.use(
  "/api/automations",
  automationsRouter
);

app.use(
  "/api/instagram/accounts",
  instagramAccountsRouter
);

app.use(
  "/api/activity",
  activityRouter
);

app.use(
  "/api/analytics",
  analyticsRouter
);

app.use(
  "/api/billing",
  billingRouter
);

app.use(
  "/api/settings",
  settingsRouter
);

app.use(
  "/api/admin",
  adminRouter
);

app.use(
  "/dashboard",
  express.static(
    require("path").join(
      __dirname,
      "public/dashboard"
    )
  )
);

app.use(
  "/admin",
  express.static(
    require("path").join(
      __dirname,
      "public/admin"
    )
  )
);

app.use(
  "/meta",
  metaComplianceRouter
);

// ---------------------------------------------------------
// Health
// ---------------------------------------------------------

function healthResponse(
  req,
  res
) {
  return res.json({
    status: "ok",
    service: "Rithan Link DM API",
    mode: "bullmq-multi-tenant"
  });
}

app.get(
  "/",
  healthResponse
);

app.get(
  "/health",
  healthResponse
);

app.get(
  "/ready",
  async (req, res) => {
    try {
      await Promise.all([
        pool.query("SELECT 1"),
        readinessRedis.ping()
      ]);

      return res.json({
        status: "ready",
        database: "ok",
        redis: "ok"
      });

    } catch (error) {
      console.error(
        "Readiness check failed:",
        error.message
      );

      return res
        .status(503)
        .json({
          status: "not_ready"
        });
    }
  }
);

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
              value,
              requestId:
                req.requestId || null
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

const httpServer =
  app.listen(
    PORT,
    "127.0.0.1",
    () => {
      console.log(
        `Rithan Link DM API running on port ${PORT} (BullMQ multi-tenant)`
      );
    }
  );

httpServer.requestTimeout =
  Number(
    process.env.HTTP_REQUEST_TIMEOUT_MS ||
    60000
  );

httpServer.headersTimeout =
  Number(
    process.env.HTTP_HEADERS_TIMEOUT_MS ||
    15000
  );

httpServer.keepAliveTimeout =
  Number(
    process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS ||
    5000
  );

// Graceful shutdown.
let shuttingDown = false;

async function closeHttpServer() {
  await new Promise((resolve) => {
    const timer =
      setTimeout(
        () => {
          httpServer
            .closeAllConnections?.();

          resolve();
        },
        10000
      );

    timer.unref?.();

    httpServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `${signal} received. Closing API...`
  );

  try {
    await closeHttpServer();
  } catch (error) {
    console.error(
      "HTTP server close error:",
      error.message
    );
  }

  try {
    await closeApiMutationRateLimiter();
  } catch (error) {
    console.error(
      "API rate limiter close error:",
      error.message
    );
  }

  try {
    await closeLoginRateLimiter();
  } catch (error) {
    console.error(
      "Login rate limiter close error:",
      error.message
    );
  }

  try {
    await closeInstagramQueue();
  } catch (error) {
    console.error(
      "Queue close error:",
      error.message
    );
  }

  try {
    await readinessRedis.quit();
  } catch (error) {
    console.error(
      "Readiness Redis close error:",
      error.message
    );
  }

  try {
    await pool.end();
  } catch (error) {
    console.error(
      "Database pool close error:",
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
