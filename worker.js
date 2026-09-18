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
              delay: 5000
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

worker.on("ready", () => {
  console.log(
    `Instagram worker ready: ${queueName}`
  );
});

worker.on(
  "completed",
  (job) => {
    console.log(
      "Instagram job completed:",
      job.id
    );
  }
);

worker.on(
  "failed",
  (job, error) => {
    console.error(
      "Instagram job failed:",
      {
        jobId:
          job?.id,

        attemptsMade:
          job?.attemptsMade,

        error:
          error.message
      }
    );
  }
);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

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
