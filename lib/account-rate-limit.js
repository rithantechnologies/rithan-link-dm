const {
  createRedisConnection
} = require("./redis");

const redis =
  createRedisConnection();

const minIntervalMs =
  Number(
    process.env.INSTAGRAM_ACCOUNT_MIN_INTERVAL_MS ||
    1000
  );

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

async function waitForAccountSlot(
  professionalAccountId
) {
  const key =
    `ratelimit:instagram:${professionalAccountId}`;

  while (true) {
    const acquired =
      await redis.set(
        key,
        String(Date.now()),
        "PX",
        minIntervalMs,
        "NX"
      );

    if (acquired === "OK") {
      return;
    }

    const ttl =
      await redis.pttl(key);

    const waitMs =
      ttl > 0
        ? ttl + 10
        : 50;

    await sleep(waitMs);
  }
}

async function closeAccountRateLimiter() {
  await redis.quit();
}

module.exports = {
  waitForAccountSlot,
  closeAccountRateLimiter
};
