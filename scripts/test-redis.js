require("dotenv").config();

const {
  createRedisConnection
} = require("../lib/redis");

async function main() {
  const redis = createRedisConnection();

  const result = await redis.ping();

  console.log("Redis connected:", result);

  await redis.quit();
}

main().catch((error) => {
  console.error("Redis test failed:", error.message);
  process.exitCode = 1;
});
