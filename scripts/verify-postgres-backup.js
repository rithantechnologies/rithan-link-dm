require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  spawnSync
} = require("child_process");
const {
  Client
} = require("pg");

const backupDir =
  process.env.POSTGRES_BACKUP_DIR ||
  path.join(
    __dirname,
    "../var/backups/postgres"
  );

const dbArgIndex =
  process.argv.indexOf(
    "--database"
  );

const restoreDatabase =
  dbArgIndex >= 0
    ? process.argv[
        dbArgIndex + 1
      ]
    : null;

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

function latestBackup() {
  const files =
    fs.readdirSync(backupDir)
      .filter(
        name =>
          name.endsWith(
            ".dump"
          )
      )
      .map(name => ({
        name,
        fullPath:
          path.join(
            backupDir,
            name
          ),
        mtime:
          fs.statSync(
            path.join(
              backupDir,
              name
            )
          ).mtimeMs
      }))
      .sort(
        (a, b) =>
          b.mtime - a.mtime
      );

  if (!files.length) {
    throw new Error(
      "No PostgreSQL backup found"
    );
  }

  return files[0].fullPath;
}

function checksum(filePath) {
  const hash =
    crypto.createHash("sha256");

  hash.update(
    fs.readFileSync(filePath)
  );

  return hash.digest("hex");
}
async function restoredCounts(
  database
) {
  const client =
    new Client({
      host:
        process.env.DB_HOST,
      port:
        Number(
          process.env.DB_PORT ||
          5432
        ),
      database,
      user:
        process.env.DB_USER,
      password:
        process.env.DB_PASSWORD
    });

  await client.connect();

  try {
    const result =
      await client.query(`
        SELECT
          current_database()
            AS database_name,

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

    return Object.fromEntries(
      Object.entries(
        result.rows[0]
      )
        .map(
          ([key, value]) => [
            key,
            typeof value ===
              "string" &&
            /^\d+$/.test(value)
              ? Number(value)
              : value
          ]
        )
    );

  } finally {
    await client.end();
  }
}
async function main() {
  const dumpPath =
    latestBackup();

  const checksumPath =
    `${dumpPath}.sha256`;

  const manifestPath =
    `${dumpPath}.manifest.json`;

  if (
    !fs.existsSync(
      checksumPath
    ) ||
    !fs.existsSync(
      manifestPath
    )
  ) {
    throw new Error(
      "Backup checksum or manifest is missing"
    );
  }

  const expectedChecksum =
    fs.readFileSync(
      checksumPath,
      "utf8"
    )
      .trim()
      .split(/\s+/)[0];

  const actualChecksum =
    checksum(dumpPath);

  if (
    actualChecksum !==
    expectedChecksum
  ) {
    throw new Error(
      "Backup checksum mismatch"
    );
  }

  const toc =
    run(
      "pg_restore",
      [
        "--list",
        dumpPath
      ]
    );

  if (
    !toc.includes(
      "TABLE public"
    )
  ) {
    throw new Error(
      "Backup archive does not contain public tables"
    );
  }

  const manifest =
    JSON.parse(
      fs.readFileSync(
        manifestPath,
        "utf8"
      )
    );

  const result = {
    status: "ok",
    backupFile:
      dumpPath,
    checksum: "ok",
    archive: "readable",
    archiveBytes:
      fs.statSync(
        dumpPath
      ).size,
    createdAt:
      manifest.createdAt
  };

  if (!restoreDatabase) {
    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );

    return;
  }
  run(
    "pg_restore",
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
      restoreDatabase,

      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
      dumpPath
    ],
    {
      PGPASSWORD:
        process.env.DB_PASSWORD
    }
  );

  const restored =
    await restoredCounts(
      restoreDatabase
    );

  const expected =
    manifest.database;

  const compareKeys = [
    "workspaces",
    "instagram_accounts",
    "instagram_connections",
    "automations",
    "processed_comments",
    "dm_logs",
    "public_reply_logs",
    "users"
  ];

  const mismatches =
    compareKeys
      .filter(
        key =>
          Number(
            restored[key]
          ) !==
          Number(
            expected[key]
          )
      )
      .map(key => ({
        key,
        expected:
          expected[key],
        restored:
          restored[key]
      }));

  if (mismatches.length) {
    throw new Error(
      `Restore verification mismatch: ${JSON.stringify(
        mismatches
      )}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ...result,
        restoreDatabase,
        restore: "verified",
        counts:
          Object.fromEntries(
            compareKeys.map(
              key => [
                key,
                restored[key]
              ]
            )
          )
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    "PostgreSQL backup verification failed:",
    error.message
  );

  process.exit(1);
});
