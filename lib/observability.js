const crypto = require("crypto");
const { emit, recordServiceEvent } = require("./ops");

function safeRequestId(value) {
  const input = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(input)
    ? input
    : crypto.randomUUID();
}

function requestObservability(req, res, next) {
  const requestId = safeRequestId(req.get("x-request-id"));
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const fields = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      workspaceId: req.auth?.workspaceId || null,
      userId: req.auth?.userId || null
    };
    emit(res.statusCode >= 500 ? "error" : "info", "http_request", fields);
    if (res.statusCode >= 500) {
      recordServiceEvent({
        serviceName: "api",
        severity: "error",
        eventType: "http_server_error",
        requestId,
        workspaceId: req.auth?.workspaceId || null,
        message: `${req.method} ${req.path} returned ${res.statusCode}`,
        metadata: fields
      });
    }
  });

  next();
}

module.exports = {
  requestObservability
};
