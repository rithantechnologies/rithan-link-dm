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
async function main() {
  const failures = [];
  const warnings = [];

  const readyController =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        readyController.abort(),
      4000
    );

  try {
    const response =
      await fetch(
        "http://127.0.0.1:3100/ready",
        {
          signal:
            readyController.signal
        }
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

  } finally {
    clearTimeout(timeout);
  }

  let publicStatus = null;
  let tlsRemaining = null;

  const publicController =
    new AbortController();

  const publicTimeout =
    setTimeout(
      () =>
        publicController.abort(),
      5000
    );

  try {
    const response =
      await fetch(
        new URL(
          "/health",
          publicApiUrl
        ),
        {
          signal:
            publicController.signal
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

  } finally {
    clearTimeout(
      publicTimeout
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

  try {
    const counts =
      await queue.getJobCounts(
        "waiting",
        "active",
        "failed",
        "delayed",
        "paused"
      );

    const backlog =
      Number(
        counts.waiting || 0
      ) +
      Number(
        counts.delayed || 0
      );

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
