const pool = require("../db");

function emit(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    service: process.env.SERVICE_NAME || "rithan-link-dm",
    ...fields
  };
  const line = JSON.stringify(payload);
  if (level === "error" || level === "critical") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.log(line);
}

async function recordServiceEvent({
  serviceName = "api",
  severity = "info",
  eventType,
  requestId = null,
  workspaceId = null,
  message = null,
  metadata = {}
}) {
  emit(severity, eventType, {
    requestId,
    workspaceId,
    message,
    ...metadata
  });
  try {
    await pool.query(
      `INSERT INTO service_events
       (service_name,severity,event_type,request_id,workspace_id,message,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        serviceName,
        severity,
        eventType,
        requestId,
        workspaceId,
        message ? String(message).slice(0, 2000) : null,
        JSON.stringify(metadata || {})
      ]
    );
  } catch (error) {
    emit("error", "service_event_persist_failed", {
      eventType,
      error: error.message
    });
  }
}

module.exports = {
  emit,
  recordServiceEvent
};
