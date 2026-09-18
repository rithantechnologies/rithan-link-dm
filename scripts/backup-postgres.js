require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  spawnSync
} = require("child_process");

const pool = require("../db");

const backupDir =
  process.env.POSTGRES_BACKUP_DIR ||
  path.join(
    __dirname,
    "../var/backups/postgres"
  );

const retentionDays =
  Math.max(
    1,
    Number(
      process.env
        .POSTGRES_BACKUP_RETENTION_DAYS ||
      14
    )
  );

function run(
  command,
  args,
  extraEnv = {}
) {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...extraEnv
        }
      }
    );

  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(
        result.stderr || result.stdout || ""
      ).trim()}`
    );
  }

  return result.stdout;
}

function sha256(filePath) {
  const hash =
    crypto.createHash("sha256");

  const data =
    fs.readFileSync(filePath);

  hash.update(data);

  return hash.digest("hex");
}

function timestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-");
}
async function databaseManifest() {
  const result =
    await pool.query(`
      SELECT
        current_database()
          AS database_name,

        pg_database_size(
          current_database()
        )::bigint
          AS database_size_bytes,

        (
          SELECT COUNT(*)::bigint
          FROM workspaces
        ) AS workspaces,

        (
          SELECT COUNT(*)::bigint
          FROM instagram_accounts
        ) AS instagram_accounts,

        (
          SELECT COUNT(*)::bigint
          FROM instagram_connections
        ) AS instagram_connections,

        (
          SELECT COUNT(*)::bigint
          FROM automations
        ) AS automations,

        (
          SELECT COUNT(*)::bigint
          FROM processed_comments
        ) AS processed_comments,

        (
          SELECT COUNT(*)::bigint
          FROM dm_logs
        ) AS dm_logs,

        (
          SELECT COUNT(*)::bigint
          FROM public_reply_logs
        ) AS public_reply_logs,

        (
          SELECT COUNT(*)::bigint
          FROM users
        ) AS users
    `);

  const row =
    result.rows[0];

  return Object.fromEntries(
    Object.entries(row)
      .map(([key, value]) => [
        key,
        typeof value === "string" &&
        /^\d+$/.test(value)
          ? Number(value)
          : value
      ])
  );
}

function removeOldBackups() {
  const cutoff =
    Date.now() -
    retentionDays *
      24 * 60 * 60 * 1000;

  for (
    const entry of
    fs.readdirSync(backupDir)
  ) {
    if (
      !entry.startsWith(
        "rithan-link-dm-"
      )
    ) {
      continue;
    }

    const fullPath =
      path.join(
        backupDir,
        entry
      );

    const stat =
      fs.statSync(fullPath);

    if (
      stat.isFile() &&
      stat.mtimeMs < cutoff
    ) {
      fs.unlinkSync(fullPath);
    }
  }
}
async function main() {
  fs.mkdirSync(
    backupDir,
    {
      recursive: true,
      mode: 0o700
    }
  );

  fs.chmodSync(
    backupDir,
    0o700
  );

  const stamp =
    timestamp();

  const base =
    `rithan-link-dm-${stamp}`;

  const tempPath =
    path.join(
      backupDir,
      `${base}.dump.partial`
    );

  const finalPath =
    path.join(
      backupDir,
      `${base}.dump`
    );

  const checksumPath =
    `${finalPath}.sha256`;

  const manifestPath =
    `${finalPath}.manifest.json`;

  const pgEnv = {
    PGPASSWORD:
      process.env.DB_PASSWORD
  };

  try {
    run(
      "pg_dump",
      [
        "--host",
        process.env.DB_HOST ||
          "127.0.0.1",

        "--port",
        String(
          process.env.DB_PORT ||
          5432
        ),

        "--username",
        process.env.DB_USER,

        "--dbname",
        process.env.DB_NAME,

        "--format=custom",
        "--compress=9",
        "--no-owner",
        "--no-privileges",
        "--file",
        tempPath
      ],
      pgEnv
    );

    run(
      "pg_restore",
      [
        "--list",
        tempPath
      ]
    );

    fs.renameSync(
      tempPath,
      finalPath
    );

    const checksum =
      sha256(finalPath);

    fs.writeFileSync(
      checksumPath,
      `${checksum}  ${path.basename(
        finalPath
      )}\n`,
      {
        mode: 0o600
      }
    );

    const manifest = {
      createdAt:
        new Date()
          .toISOString(),

      backupFile:
        path.basename(
          finalPath
        ),

      sha256:
        checksum,

      archiveBytes:
        fs.statSync(
          finalPath
        ).size,

      retentionDays,

      database:
        await databaseManifest()
    };

    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        manifest,
        null,
        2
      ) + "\n",
      {
        mode: 0o600
      }
    );

    fs.chmodSync(
      finalPath,
      0o600
    );

    removeOldBackups();

    console.log(
      JSON.stringify(
        {
          status: "ok",
          backupFile:
            finalPath,
          archiveBytes:
            manifest.archiveBytes,
          sha256:
            checksum,
          retentionDays,
          database:
            manifest.database
        },
        null,
        2
      )
    );

  } finally {
    if (
      fs.existsSync(
        tempPath
      )
    ) {
      fs.unlinkSync(
        tempPath
      );
    }

    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "PostgreSQL backup failed:",
    error.message
  );

  process.exit(1);
});
