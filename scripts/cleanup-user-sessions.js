require("dotenv").config();

const pool = require("../db");
const path = require("path");
const {
  execFileSync
} = require("child_process");

const {
  cleanupUserSessions
} = require("../lib/session-maintenance");


async function main() {
  const dryRun =
    process.argv.includes(
      "--dry-run"
    );

  const retentionDays =
    Math.max(
      0,
      Number(
        process.env
          .REVOKED_SESSION_RETENTION_DAYS ||
        7
      )
    );

  if (dryRun) {
    const result =
      await pool.query(
        `
        SELECT COUNT(*)::int
          AS removable_sessions

        FROM user_sessions

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

    console.log({
      dryRun: true,
      removableSessions:
        result.rows[0]
          .removable_sessions,
      revokedRetentionDays:
        retentionDays
    });

    return;
  }

  const deleted =
    await cleanupUserSessions(
      pool
    );

  console.log({
    deletedSessions:
      deleted,
    revokedRetentionDays:
      retentionDays
  });

  execFileSync(
    process.execPath,
    [
      path.join(
        __dirname,
        "cleanup-activity-history.js"
      )
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  execFileSync(
    process.execPath,
    [
      path.join(
        __dirname,
        "cleanup-webhook-events.js"
      )
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  execFileSync(
    process.execPath,
    [
      path.join(
        __dirname,
        "cleanup-audit-logs.js"
      )
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  execFileSync(
    process.execPath,
    [
      path.join(
        __dirname,
        "cleanup-oauth-states.js"
      )
    ],
    {
      stdio: "inherit",
      env: process.env
    }
  );
}


main()
  .catch(error => {
    console.error(
      "Session cleanup failed:",
      error.message
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
