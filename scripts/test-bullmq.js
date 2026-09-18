require("dotenv").config();

const {
  Queue,
  Worker
} = require("bullmq");

const {
  createRedisConnection
} = require("../lib/redis");

const queueName =
  process.env.INSTAGRAM_QUEUE_NAME ||
  "instagram-comment-jobs";

async function main() {
  const queueConnection =
    createRedisConnection();

  const workerConnection =
    createRedisConnection();

  const queue = new Queue(queueName, {
    connection: queueConnection
  });

  const worker = new Worker(
    queueName,

    async (job) => {
      console.log(
        "Worker received:",
        job.name,
        job.data
      );

      return {
        success: true
      };
    },

    {
      connection: workerConnection,
      concurrency: 2
    }
  );

  worker.on("completed", (job) => {
    console.log("Job completed:", job.id);
  });

  worker.on("failed", (job, error) => {
    console.error(
      "Job failed:",
      job?.id,
      error.message
    );
  });

  const job = await queue.add(
    "test-comment",
    {
      account: "rithantechnologies",
      commentId: "test-001"
    },
    {
      removeOnComplete: true,
      removeOnFail: false
    }
  );

  console.log("Job queued:", job.id);

  await new Promise((resolve) =>
    setTimeout(resolve, 2000)
  );

  await worker.close();
  await queue.close();

  await workerConnection.quit();
  await queueConnection.quit();
}

main().catch((error) => {
  console.error("BullMQ test failed:", error);
  process.exitCode = 1;
});
