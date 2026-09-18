const pool = require("../db");


function cleanMetadata(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const blocked =
    new Set([
      "password",
      "token",
      "accessToken",
      "access_token",
      "authorization",
      "cookie",
      "session"
    ]);

  const output = {};

  for (
    const [key, item]
    of Object.entries(value)
  ) {
    if (
      blocked.has(
        String(key)
      )
    ) {
      continue;
    }

    output[key] = item;
  }

  return output;
}


async function writeAuditLog({
  workspaceId = null,
  userId = null,
  eventType,
  targetType = null,
  targetId = null,
  ipAddress = null,
  userAgent = null,
  metadata = {}
}) {
  if (!eventType) {
    throw new Error(
      "eventType is required"
    );
  }

  await pool.query(
    `
    INSERT INTO audit_logs (
      workspace_id,
      user_id,
      event_type,
      target_type,
      target_id,
      ip_address,
      user_agent,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8::jsonb
    )
    `,
    [
      workspaceId,
      userId,
      eventType,
      targetType,
      targetId
        ? String(targetId)
        : null,
      ipAddress
        ? String(ipAddress)
        : null,
      userAgent
        ? String(userAgent).slice(
            0,
            1000
          )
        : null,
      JSON.stringify(
        cleanMetadata(metadata)
      )
    ]
  );
}


async function safeAuditLog(data) {
  try {
    await writeAuditLog(data);
  } catch (error) {
    console.error(
      "Audit log write failed:",
      error.message
    );
  }
}


module.exports = {
  writeAuditLog,
  safeAuditLog
};
