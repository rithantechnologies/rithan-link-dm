require("dotenv").config();

const {
  Worker
} = require("bullmq");

const {
  createRedisConnection
} = require("./lib/redis");

const {
  instagramQueue,
  closeInstagramQueue
} = require("./lib/instagram-queue");

const pool =
  require("./db");

const {
  emit,
  recordServiceEvent
} = require("./lib/ops");

const {
  processInstagramCommentJob
} = require(
  "./lib/instagram-comment-processor"
);

const {
  processInstagramPublicReplyJob
} = require(
  "./lib/instagram-public-reply-processor"
);

const {
  waitForAccountSlot,
  closeAccountRateLimiter
} = require(
  "./lib/account-rate-limit"
);

const queueName =
  process.env.INSTAGRAM_QUEUE_NAME ||
  "instagram-comment-jobs";

const connection =
  createRedisConnection();

const worker =
  new Worker(
    queueName,

    async (job) => {
      emit(
        "info",
        "instagram_job_started",
        {
          jobId:
            job.id,
          jobName:
            job.name,
          requestId:
            job.data?.requestId || null,
          professionalAccountId:
            job.data?.professionalAccountId || null,
          attemptsMade:
            job.attemptsMade
        }
      );

      if (
        job.name ===
        "instagram-public-reply"
      ) {
        const professionalAccountId =
          String(
            job.data
              ?.professionalAccountId ||
            ""
          );

        if (!professionalAccountId) {
          return {
            ignored: true,
            reason:
              "missing_professional_account_id"
          };
        }

        await waitForAccountSlot(
          professionalAccountId
        );

        console.log(
          "Public reply rate slot acquired:",
          {
            jobId: job.id,
            professionalAccountId
          }
        );

        return processInstagramPublicReplyJob(
          job.data
        );
      }

      if (
        job.name !==
        "instagram-comment"
      ) {
        console.log(
          "Ignoring unknown job type:",
          job.name
        );

        return;
      }

      const maxAgeMs =
        6 * 24 * 60 * 60 * 1000;

      if (
        Date.now() - job.timestamp >
        maxAgeMs
      ) {
        console.log(
          "Dropping expired Instagram job:",
          job.id
        );

        return {
          ignored: true,
          reason: "job_expired"
        };
      }

      const professionalAccountId =
        String(
          job.data
            ?.professionalAccountId ||
          ""
        );

      if (!professionalAccountId) {
        console.log(
          "Dropping job without account ID:",
          job.id
        );

        return {
          ignored: true,
          reason:
            "missing_professional_account_id"
        };
      }

      // Redis-backed spacing is independent
      // for every Instagram Professional account.
      await waitForAccountSlot(
        professionalAccountId
      );

      console.log(
        "Account rate slot acquired:",
        {
          jobId: job.id,
          professionalAccountId
        }
      );

      const result =
        await processInstagramCommentJob(
          job.data
        );

      if (
        result?.success &&
        result?.publicReply
      ) {
        await instagramQueue.add(
          "instagram-public-reply",
          {
            commentId:
              result.commentId,

            professionalAccountId
          },
          {
            jobId:
              `public-${result.commentId}`,

            attempts: 5,

            backoff: {
              type: "exponential",
              delay:
                Math.max(
                  10000,
                  Number(
                    process.env.INSTAGRAM_RETRY_BASE_DELAY_MS ||
                    60000
                  )
                )
            }
          }
        );

        console.log(
          "Public reply queued:",
          result.commentId
        );
      }

      return result;
    },

    {
      connection,

      // Different customer accounts can still
      // process concurrently.
      concurrency: 5
    }
  );

async function writeWorkerHeartbeat() {
  try {
    await pool.query(
      `
      INSERT INTO service_heartbeats (
        service_name,
        heartbeat_at,
        metadata
      )
      VALUES (
        'instagram-worker',
        NOW(),
        $1::jsonb
      )
      ON CONFLICT (service_name)
      DO UPDATE SET
        heartbeat_at = NOW(),
        metadata = EXCLUDED.metadata
      `,
      [
        JSON.stringify({
          queueName,
          pid:
            process.pid,
          concurrency: 5,
          queueCounts:
            await instagramQueue.getJobCounts(
              "waiting",
              "active",
              "delayed",
              "failed"
            )
        })
      ]
    );

  } catch (error) {
    console.error(
      "Worker heartbeat failed:",
      error.message
    );
  }
}

const heartbeatTimer =
  setInterval(
    writeWorkerHeartbeat,
    30000
  );

heartbeatTimer.unref?.();

worker.on("ready", () => {
  console.log(
    `Instagram worker ready: ${queueName}`
  );

  writeWorkerHeartbeat();
});

worker.on(
  "completed",
  (job) => {
    emit(
      "info",
      "instagram_job_completed",
      {
        jobId:
          job.id,
        jobName:
          job.name,
        requestId:
          job.data?.requestId || null,
        attemptsMade:
          job.attemptsMade
      }
    );
  }
);

async function notifyTerminalFailure(job, error) {
  const attempts =
    Number(job?.opts?.attempts || 1);

  if (
    Number(job?.attemptsMade || 0) <
    attempts
  ) {
    return;
  }

  const professionalAccountId =
    job?.data?.professionalAccountId ||
    null;

  if (!professionalAccountId) {
    return;
  }

  try {
    const result =
      await pool.query(
        `
        SELECT
          latest.workspace_id,
          w.notify_failures,
          ia.username
        FROM instagram_accounts ia
        JOIN LATERAL (
          SELECT
            ic.workspace_id
          FROM instagram_connections ic
          WHERE
            ic.instagram_account_id =
              ia.id
          ORDER BY
            ic.connected_at DESC,
            ic.created_at DESC
          LIMIT 1
        ) latest ON TRUE
        JOIN workspaces w
          ON w.id =
             latest.workspace_id
        WHERE
          ia.professional_account_id = $1
        LIMIT 1
        `,
        [professionalAccountId]
      );

    const row =
      result.rows[0];

    if (!row?.notify_failures) {
      return;
    }

    const jobId =
      String(job?.id || "unknown");

    await pool.query(
      `
      INSERT INTO workspace_notifications (
        workspace_id,
        notification_type,
        severity,
        title,
        message,
        action_url,
        dedupe_key
      )
      VALUES (
        $1,
        'delivery_failure',
        'critical',
        'Automation delivery needs attention',
        $2,
        '/dashboard/?page=activity',
        $3
      )
      ON CONFLICT (workspace_id,dedupe_key)
      WHERE dedupe_key IS NOT NULL
      DO UPDATE SET
        message=EXCLUDED.message,
        severity=EXCLUDED.severity
      `,
      [
        row.workspace_id,
        `A delivery job for @${row.username || "Instagram"} exhausted all retries: ${String(error.message).slice(0, 400)}`,
        `delivery-failure:${jobId}`
      ]
    );
  } catch (notificationError) {
    emit(
      "error",
      "failure_notification_failed",
      {
        jobId:
          job?.id || null,
        error:
          notificationError.message
      }
    );
  }
}

worker.on(
  "failed",
  (job, error) => {
    const metadata = {
      jobId:
        job?.id || null,
      jobName:
        job?.name || null,
      requestId:
        job?.data?.requestId || null,
      attemptsMade:
        job?.attemptsMade || 0,
      professionalAccountId:
        job?.data?.professionalAccountId || null
    };

    emit(
      "error",
      "instagram_job_failed",
      {
        ...metadata,
        error:
          error.message
      }
    );

    recordServiceEvent({
      serviceName:
        "instagram-worker",
      severity:
        "error",
      eventType:
        "instagram_job_failed",
      message:
        error.message,
      metadata
    });

    notifyTerminalFailure(
      job,
      error
    );
  }
);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  clearInterval(
    heartbeatTimer
  );

  console.log(
    `${signal} received. Closing worker...`
  );

  try {
    await worker.close();
  } catch (error) {
    console.error(
      "Worker close error:",
      error.message
    );
  }

  try {
    await closeAccountRateLimiter();
  } catch (error) {
    console.error(
      "Rate limiter close error:",
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
    await connection.quit();
  } catch (error) {
    console.error(
      "Redis close error:",
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
