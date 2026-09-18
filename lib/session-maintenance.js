const pool = require("../db");

const MAX_ACTIVE_SESSIONS =
  Math.max(
    1,
    Number(
      process.env.MAX_ACTIVE_SESSIONS || 5
    )
  );


async function enforceActiveSessionLimit(
  db,
  userId,
  maxSessions = MAX_ACTIVE_SESSIONS
) {
  const result =
    await db.query(
      `
      WITH sessions_to_revoke AS (
        SELECT id

        FROM user_sessions

        WHERE
          user_id = $1
          AND revoked_at IS NULL
          AND expires_at > NOW()

        ORDER BY
          created_at DESC,
          id DESC

        OFFSET $2::int
      )

      UPDATE user_sessions

      SET revoked_at = NOW()

      WHERE id IN (
        SELECT id
        FROM sessions_to_revoke
      )

      RETURNING id
      `,
      [
        userId,
        maxSessions
      ]
    );

  return result.rowCount;
}


async function cleanupUserSessions(
  db = pool
) {
  const retentionDays =
    Math.max(
      0,
      Number(
        process.env
          .REVOKED_SESSION_RETENTION_DAYS ||
        7
      )
    );

  const result =
    await db.query(
      `
      DELETE FROM user_sessions

      WHERE
        expires_at <= NOW()

        OR (
          revoked_at IS NOT NULL

          AND revoked_at <=
            NOW() -
            (
              $1::double precision *
              INTERVAL '1 day'
            )
        )
      `,
      [
        retentionDays
      ]
    );

  return result.rowCount;
}


module.exports = {
  MAX_ACTIVE_SESSIONS,
  enforceActiveSessionLimit,
  cleanupUserSessions
};
