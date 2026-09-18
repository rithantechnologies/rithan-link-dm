require("dotenv").config();

const fs = require("fs");
const path = require("path");
const tls = require("tls");

const {
  Queue
} = require("bullmq");

const pool = require("../db");

const {
  createRedisConnection
} = require("../lib/redis");

const backupDir =
  process.env.POSTGRES_BACKUP_DIR ||
  path.join(
    __dirname,
    "../var/backups/postgres"
  );

const maxBackupAgeHours =
  Math.max(
    1,
    Number(
      process.env
        .BACKUP_MAX_AGE_HOURS ||
      36
    )
  );

const maxQueueBacklog =
  Math.max(
    1,
    Number(
      process.env
        .QUEUE_BACKLOG_ALERT_THRESHOLD ||
      100
    )
  );

const maxDiskPercent =
  Math.min(
    99,
    Math.max(
      50,
      Number(
        process.env
          .DISK_USAGE_ALERT_PERCENT ||
        85
      )
    )
  );

const publicApiUrl =
  new URL(
    process.env.PUBLIC_API_URL ||
    "https://api.rithantechnologies.com"
  );

const opsAlertWebhookUrl =
  process.env.OPS_ALERT_WEBHOOK_URL ||
  null;

const maxOldestJobAgeSeconds =
  Math.max(
    30,
    Number(
      process.env.QUEUE_OLDEST_JOB_ALERT_SECONDS ||
      300
    )
  );

function tlsDaysRemaining() {
  return new Promise(
    (resolve, reject) => {
      const socket =
        tls.connect(
          {
            host:
              publicApiUrl.hostname,
            port:
              Number(
                publicApiUrl.port ||
                443
              ),
            servername:
              publicApiUrl.hostname,
            rejectUnauthorized:
              true
          },
          () => {
            try {
              const cert =
                socket.getPeerCertificate();

              const expiresAt =
                Date.parse(
                  cert.valid_to
                );

              if (
                !Number.isFinite(
                  expiresAt
                )
              ) {
                throw new Error(
                  "certificate_expiry_missing"
                );
              }

              resolve(
                (
                  expiresAt -
                  Date.now()
                ) /
                86400000
              );

            } catch (error) {
              reject(error);

            } finally {
              socket.end();
            }
          }
        );

      socket.setTimeout(
        5000,
        () => {
          socket.destroy(
            new Error(
              "tls_timeout"
            )
          );
        }
      );

      socket.once(
        "error",
        reject
      );
    }
  );
}

function newestBackupAgeHours() {
  if (
    !fs.existsSync(
      backupDir
    )
  ) {
    return Infinity;
  }

  const dumps =
    fs.readdirSync(
      backupDir
    )
      .filter(
        name =>
          name.endsWith(
            ".dump"
          )
      )
      .map(
        name =>
          fs.statSync(
            path.join(
              backupDir,
              name
            )
          ).mtimeMs
      );

  if (!dumps.length) {
    return Infinity;
  }

  return (
    Date.now() -
    Math.max(...dumps)
  ) / 3600000;
}

async function sendOpsAlert(result) {
  if (!opsAlertWebhookUrl) {
    return;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      5000
    );

  try {
    const response =
      await fetch(
        opsAlertWebhookUrl,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            source:
              "rithan-link-dm",
            ...result
          }),
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `alert_webhook_http_${response.status}`
      );
    }
  } catch (error) {
    console.error(
      "Ops alert webhook failed:",
      error.message
    );
  } finally {
    clearTimeout(timeout);
  }
}

function diskUsagePercent() {
  const stat =
    fs.statfsSync("/");

  const total =
    Number(
      stat.blocks
    );

  const available =
    Number(
      stat.bavail
    );

  if (!total) {
    return 0;
  }

  return (
    (total - available) /
    total
  ) * 100;
}
function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

async function fetchWithRetry(
  url,
  {
    attempts = 5,
    timeoutMs = 4000,
    delayMs = 750
  } = {}
) {
  let lastError = null;

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt += 1
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          url,
          {
            signal:
              controller.signal
          }
        );

      if (
        response.ok ||
        attempt === attempts
      ) {
        return response;
      }

      lastError =
        new Error(
          `HTTP ${response.status}`
        );

    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        throw error;
      }

    } finally {
      clearTimeout(timeout);
    }

    await sleep(delayMs);
  }

  throw lastError ||
    new Error(
      "health_fetch_failed"
    );
}

async function main() {
  const failures = [];
  const warnings = [];

  try {
    const response =
      await fetchWithRetry(
        "http://127.0.0.1:3100/ready"
      );

    if (!response.ok) {
      failures.push(
        `ready_http_${response.status}`
      );
    } else {
      const body =
        await response.json();

      if (
        body.status !== "ready" ||
        body.database !== "ok" ||
        body.redis !== "ok"
      ) {
        failures.push(
          "ready_dependency_failure"
        );
      }
    }

  } catch (error) {
    failures.push(
      `ready_unreachable:${error.name}`
    );
  }

  let publicStatus = null;
  let tlsRemaining = null;

  try {
    const response =
      await fetchWithRetry(
        new URL(
          "/health",
          publicApiUrl
        ),
        {
          timeoutMs: 5000
        }
      );

    publicStatus =
      response.status;

    if (!response.ok) {
      failures.push(
        `public_health_http_${response.status}`
      );
    }

  } catch (error) {
    failures.push(
      `public_health_unreachable:${error.name}`
    );
  }

  try {
    tlsRemaining =
      await tlsDaysRemaining();

    if (
      tlsRemaining <= 7
    ) {
      failures.push(
        `tls_expiry_critical:${tlsRemaining.toFixed(1)}d`
      );

    } else if (
      tlsRemaining <= 21
    ) {
      warnings.push(
        `tls_expiry_warning:${tlsRemaining.toFixed(1)}d`
      );
    }

  } catch (error) {
    failures.push(
      `tls_check_failed:${error.message}`
    );
  }

  const redis =
    createRedisConnection();

  const queue =
    new Queue(
      process.env
        .INSTAGRAM_QUEUE_NAME ||
        "instagram-comment-jobs",
      {
        connection:
          redis
      }
    );

  let queueStats = null;

  try {
    const counts =
      await queue.getJobCounts(
        "waiting",
        "active",
        "failed",
        "delayed",
        "paused"
      );

    const pending =
      await queue.getJobs(
        ["waiting", "delayed"],
        0,
        0,
        true
      );

    const backlog =
      Number(
        counts.waiting || 0
      ) +
      Number(
        counts.delayed || 0
      );

    const oldestPendingAgeSeconds =
      pending[0]?.timestamp
        ? Math.max(
            0,
            Math.round(
              (
                Date.now() -
                pending[0].timestamp
              ) / 1000
            )
          )
        : null;

    queueStats = {
      ...counts,
      backlog,
      oldestPendingAgeSeconds
    };

    if (
      Number(
        counts.failed || 0
      ) > 0
    ) {
      failures.push(
        `queue_failed_jobs:${counts.failed}`
      );
    }

    if (
      backlog >
      maxQueueBacklog
    ) {
      failures.push(
        `queue_backlog:${backlog}`
      );
    }

    if (
      oldestPendingAgeSeconds !== null &&
      oldestPendingAgeSeconds >
        maxOldestJobAgeSeconds
    ) {
      failures.push(
        `queue_oldest_job_age_seconds:${oldestPendingAgeSeconds}`
      );
    }

  } finally {
    try {
      await queue.close();
    } catch {}

    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }

  const backupAge =
    newestBackupAgeHours();

  if (
    !Number.isFinite(
      backupAge
    ) ||
    backupAge >
      maxBackupAgeHours
  ) {
    failures.push(
      `backup_stale_hours:${
        Number.isFinite(
          backupAge
        )
          ? backupAge.toFixed(1)
          : "missing"
      }`
    );

  } else if (
    backupAge > 26
  ) {
    warnings.push(
      `backup_age_hours:${backupAge.toFixed(1)}`
    );
  }
  const diskPercent =
    diskUsagePercent();

  if (
    diskPercent >=
    maxDiskPercent
  ) {
    failures.push(
      `disk_usage_percent:${diskPercent.toFixed(1)}`
    );

  } else if (
    diskPercent >= 75
  ) {
    warnings.push(
      `disk_usage_percent:${diskPercent.toFixed(1)}`
    );
  }

  const tokens =
    await pool.query(`
      SELECT
        ia.username,
        ic.token_expires_at,

        EXTRACT(
          EPOCH FROM (
            ic.token_expires_at -
            NOW()
          )
        ) / 86400.0
          AS days_remaining

      FROM instagram_connections ic

      JOIN instagram_accounts ia
        ON ia.id =
           ic.instagram_account_id

      WHERE
        ic.status = 'connected'
    `);

  for (
    const row of
    tokens.rows
  ) {
    const days =
      Number(
        row.days_remaining
      );

    if (
      !row.token_expires_at ||
      !Number.isFinite(days)
    ) {
      failures.push(
        `token_expiry_missing:${row.username || "unknown"}`
      );

    } else if (days <= 5) {
      failures.push(
        `token_expiry_critical:${row.username}:${days.toFixed(1)}d`
      );

    } else if (days <= 14) {
      warnings.push(
        `token_expiry_warning:${row.username}:${days.toFixed(1)}d`
      );
    }
  }

  const result = {
    status:
      failures.length
        ? "failed"
        : "ok",

    checkedAt:
      new Date()
        .toISOString(),

    backupAgeHours:
      Number.isFinite(
        backupAge
      )
        ? Number(
            backupAge.toFixed(2)
          )
        : null,

    diskUsagePercent:
      Number(
        diskPercent.toFixed(2)
      ),

    publicHealthStatus:
      publicStatus,

    tlsDaysRemaining:
      Number.isFinite(
        tlsRemaining
      )
        ? Number(
            tlsRemaining.toFixed(1)
          )
        : null,

    connectedTokenCount:
      tokens.rowCount,

    queue:
      queueStats,

    warnings,
    failures
  };

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  if (
    failures.length ||
    warnings.length
  ) {
    const severity =
      failures.length
        ? "critical"
        : "warning";

    try {
      await pool.query(
        `INSERT INTO service_events
         (service_name,severity,event_type,message,metadata)
         VALUES ('health-check',$1,'production_health',$2,$3::jsonb)`,
        [
          severity,
          failures.length
            ? failures.join("; ")
            : warnings.join("; "),
          JSON.stringify(result)
        ]
      );
    } catch (error) {
      console.error(
        "Health event persistence failed:",
        error.message
      );
    }

    await sendOpsAlert(result);
  }

  if (failures.length) {
    process.exitCode = 1;
  }
}

main()
  .catch(error => {
    console.error(
      "Production health check failed:",
      error.message
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
