class InstagramApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "InstagramApiError";
    Object.assign(this, details);
  }
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(raw);
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : 0;
}

function classifyInstagramError(response, body) {
  const errorBody = body && body.error ? body.error : {};
  const metaCode = Number(errorBody.code || 0) || null;
  const metaSubcode = Number(errorBody.error_subcode || 0) || null;
  const status = Number(response.status);
  let category = "permanent";
  let retryable = false;
  let countsTowardCircuitBreaker = false;

  if (status === 429 || [4, 17, 32, 613].includes(metaCode)) {
    category = "rate_limit";
    retryable = true;
    countsTowardCircuitBreaker = true;
  } else if (status >= 500 || status === 408 || [1, 2].includes(metaCode)) {
    category = "transient";
    retryable = true;
    countsTowardCircuitBreaker = true;
  } else if (status === 401 || metaCode === 190) {
    category = "auth";
    countsTowardCircuitBreaker = true;
  } else if (status === 403 || [10, 200].includes(metaCode)) {
    category = "permission";
    countsTowardCircuitBreaker = true;
  }

  const message = String(
    errorBody.message ||
    body?.message ||
    `Instagram API HTTP ${status}`
  );

  if (
    metaCode === 368 ||
    /temporar(?:ily|y) blocked|action blocked|restricted|spam/i.test(message)
  ) {
    category = "restriction";
    retryable = false;
    countsTowardCircuitBreaker = true;
  }

  return new InstagramApiError(message, {
    httpStatus: status,
    metaCode,
    metaSubcode,
    category,
    retryable,
    retryAfterMs: retryAfterMs(response),
    countsTowardCircuitBreaker,
    responseBody: body
  });
}

function normalizeInstagramError(error) {
  if (error instanceof InstagramApiError) {
    return error;
  }

  return new InstagramApiError(
    String(error?.message || "Instagram request failed"),
    {
      category: "network",
      retryable: true,
      retryAfterMs: 0,
      countsTowardCircuitBreaker: true,
      cause: error
    }
  );
}

module.exports = {
  InstagramApiError,
  classifyInstagramError,
  normalizeInstagramError
};
