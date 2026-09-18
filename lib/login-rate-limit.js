const crypto = require("crypto");

const {
  createRedisConnection
} = require("./redis");

const MAX_ATTEMPTS =
  Number(
    process.env.LOGIN_MAX_ATTEMPTS || 5
  );

const LOCK_SECONDS =
  Number(
    process.env.LOGIN_LOCK_SECONDS || 900
  );

let redis = null;


function getRedis() {
  if (!redis) {
    redis =
      createRedisConnection();
  }

  return redis;
}


function buildKey(
  email,
  ip
) {
  const normalizedEmail =
    String(email || "")
      .trim()
      .toLowerCase();

  const normalizedIp =
    String(ip || "unknown");

  const hash =
    crypto
      .createHash("sha256")
      .update(
        `${normalizedIp}|${normalizedEmail}`
      )
      .digest("hex");

  return (
    "rithan:auth:login-fail:" +
    hash
  );
}


async function getLoginLimitStatus(
  email,
  ip
) {
  try {
    const client =
      getRedis();

    const key =
      buildKey(
        email,
        ip
      );

    const count =
      Number(
        await client.get(key) || 0
      );

    let ttl =
      Number(
        await client.ttl(key)
      );

    if (ttl < 0) {
      ttl = 0;
    }

    return {
      limited:
        count >= MAX_ATTEMPTS,

      attempts:
        count,

      retryAfterSeconds:
        ttl
    };

  } catch (error) {
    console.error(
      "Login rate-limit check failed:",
      error.message
    );

    // Authentication should not become unavailable
    // solely because Redis is unavailable.
    return {
      limited: false,
      attempts: 0,
      retryAfterSeconds: 0,
      degraded: true
    };
  }
}


async function recordLoginFailure(
  email,
  ip
) {
  try {
    const client =
      getRedis();

    const key =
      buildKey(
        email,
        ip
      );

    const result =
      await client.eval(
        `
        local count =
          redis.call(
            "INCR",
            KEYS[1]
          )

        if count == 1 then
          redis.call(
            "EXPIRE",
            KEYS[1],
            ARGV[1]
          )
        end

        if count >= tonumber(ARGV[2]) then
          redis.call(
            "EXPIRE",
            KEYS[1],
            ARGV[1]
          )
        end

        local ttl =
          redis.call(
            "TTL",
            KEYS[1]
          )

        return {
          count,
          ttl
        }
        `,
        1,
        key,
        String(LOCK_SECONDS),
        String(MAX_ATTEMPTS)
      );

    const attempts =
      Number(
        result?.[0] || 0
      );

    const retryAfterSeconds =
      Math.max(
        Number(
          result?.[1] || 0
        ),
        0
      );

    return {
      limited:
        attempts >= MAX_ATTEMPTS,

      attempts,

      retryAfterSeconds
    };

  } catch (error) {
    console.error(
      "Login rate-limit update failed:",
      error.message
    );

    return {
      limited: false,
      attempts: 0,
      retryAfterSeconds: 0,
      degraded: true
    };
  }
}


async function clearLoginFailures(
  email,
  ip
) {
  try {
    const client =
      getRedis();

    await client.del(
      buildKey(
        email,
        ip
      )
    );

  } catch (error) {
    console.error(
      "Login rate-limit clear failed:",
      error.message
    );
  }
}


async function closeLoginRateLimiter() {
  if (!redis) {
    return;
  }

  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }

  redis = null;
}

module.exports = {
  getLoginLimitStatus,
  recordLoginFailure,
  clearLoginFailures,
  closeLoginRateLimiter,

  MAX_ATTEMPTS,
  LOCK_SECONDS
};
