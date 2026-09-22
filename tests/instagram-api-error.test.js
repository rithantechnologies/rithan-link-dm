const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyInstagramError,
  normalizeInstagramError
} = require("../lib/instagram-api-error");

function response(status, retryAfter = null) {
  return {
    status,
    headers: {
      get(name) {
        if (
          String(name).toLowerCase() === "retry-after"
        ) {
          return retryAfter;
        }
        return null;
      }
    }
  };
}

test("Instagram 429 is retryable and rate limited", () => {
  const error = classifyInstagramError(
    response(429, "120"),
    { error: { code: 4, message: "Rate limit" } }
  );

  assert.equal(error.category, "rate_limit");
  assert.equal(error.retryable, true);
  assert.equal(error.countsTowardCircuitBreaker, true);
  assert.equal(error.retryAfterMs, 120000);
});

test("Instagram auth error is permanent and safety-signaling", () => {
  const error = classifyInstagramError(
    response(400),
    { error: { code: 190, message: "Invalid token" } }
  );

  assert.equal(error.category, "auth");
  assert.equal(error.retryable, false);
  assert.equal(error.countsTowardCircuitBreaker, true);
});

test("Instagram restriction error stops retries", () => {
  const error = classifyInstagramError(
    response(400),
    { error: { code: 368, message: "Action blocked" } }
  );

  assert.equal(error.category, "restriction");
  assert.equal(error.retryable, false);
  assert.equal(error.countsTowardCircuitBreaker, true);
});

test("Instagram server errors are transient", () => {
  const error = classifyInstagramError(
    response(503),
    { error: { message: "Unavailable" } }
  );

  assert.equal(error.category, "transient");
  assert.equal(error.retryable, true);
});

test("ordinary permanent 400 does not trip breaker", () => {
  const error = classifyInstagramError(
    response(400),
    { error: { message: "Bad request" } }
  );

  assert.equal(error.category, "permanent");
  assert.equal(error.retryable, false);
  assert.equal(error.countsTowardCircuitBreaker, false);
});

test("network errors remain retryable", () => {
  const error = normalizeInstagramError(
    new Error("socket reset")
  );

  assert.equal(error.category, "network");
  assert.equal(error.retryable, true);
  assert.equal(error.countsTowardCircuitBreaker, true);
});
