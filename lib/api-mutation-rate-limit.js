const crypto = require("crypto");

const {
  createRedisConnection
} = require("./redis");

const WINDOW_SECONDS =
  Math.max(
    1,
    Number(
      process.env
        .API_MUTATION_RATE_WINDOW_SECONDS ||
      60
    )
  );

const MAX_REQUESTS =
  Math.max(
    1,
    Number(
      process.env
        .API_MUTATION_RATE_MAX_REQUESTS ||
      120
    )
  );

let redis = null;

function getRedis() {
  if (!redis) {
    redis =
      createRedisConnection();
  }

  return redis;
}
function buildKey(req) {
  const identity =
    req.auth?.userId ||
    req.ip ||
    "unknown";

  const hash =
    crypto
      .createHash("sha256")
      .update(
        String(identity)
      )
      .digest("hex");

  return (
    "rithan:api:mutation:" +
    hash
  );
}

async function apiMutationRateLimit(
  req,
  res,
  next
) {
  if (
    ![
      "POST",
      "PUT",
      "PATCH",
      "DELETE"
    ].includes(req.method)
  ) {
    return next();
  }

  try {
    const client =
      getRedis();

    const key =
      buildKey(req);
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
        String(
          WINDOW_SECONDS
        )
      );

    const count =
      Number(
        result?.[0] || 0
      );

    const ttl =
      Math.max(
        Number(
          result?.[1] || 0
        ),
        0
      );

    res.setHeader(
      "X-RateLimit-Limit",
      String(MAX_REQUESTS)
    );
    res.setHeader(
      "X-RateLimit-Remaining",
      String(
        Math.max(
          MAX_REQUESTS - count,
          0
        )
      )
    );

    if (
      count > MAX_REQUESTS
    ) {
      res.setHeader(
        "Retry-After",
        String(ttl)
      );

      return res
        .status(429)
        .json({
          error:
            "rate_limit_exceeded",
          retryAfterSeconds:
            ttl
        });
    }

    return next();

  } catch (error) {
    console.error(
      "API mutation rate-limit failed:",
      error.message
    );

    // Fail open so Redis issues do not
    // take the application offline.
    return next();
  }
}

async function closeApiMutationRateLimiter() {
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
  apiMutationRateLimit,
  closeApiMutationRateLimiter,
  WINDOW_SECONDS,
  MAX_REQUESTS
};
