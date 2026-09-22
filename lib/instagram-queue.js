const { Queue } = require("bullmq");
const { createRedisConnection } = require("./redis");

const queueName =
  process.env.INSTAGRAM_QUEUE_NAME ||
  "instagram-comment-jobs";

const connection =
  createRedisConnection();

const retryBaseDelayMs =
  Math.max(
    10000,
    Number(
      process.env.INSTAGRAM_RETRY_BASE_DELAY_MS ||
      60000
    )
  );

const instagramQueue = new Queue(queueName, {
  connection,

  defaultJobOptions: {
    attempts: 5,

    backoff: {
      type: "exponential",
      delay: retryBaseDelayMs
    },

    removeOnComplete: {
      age: 86400,
      count: 10000
    },

    removeOnFail: {
      age: 604800,
      count: 10000
    }
  }
});

async function closeInstagramQueue() {
  try {
    await instagramQueue.close();
  } finally {
    if (
      connection.status !== "end"
    ) {
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    }
  }
}

module.exports = {
  instagramQueue,
  queueName,
  closeInstagramQueue
};
