const IORedis = require("ioredis");

function createRedisConnection() {
  const redis = new IORedis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),

    // Required for BullMQ
    maxRetriesPerRequest: null
  });

  redis.on("error", (error) => {
    console.error("Redis error:", error.message);
  });

  return redis;
}

module.exports = {
  createRedisConnection
};
