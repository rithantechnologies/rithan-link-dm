require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const pool = require("../db");

const migrationsDir =
  path.join(
    __dirname,
    "../migrations"
  );

const baselineExisting =
  process.argv.includes(
    "--baseline-existing"
  );

function checksum(content) {
  return crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");
}

function migrationFiles() {
  return fs
    .readdirSync(
      migrationsDir
    )
    .filter(
      name =>
        /^\d+_.+\.sql$/.test(
          name
        )
    )
    .sort();
}

function containsExplicitTransaction(
  sql
) {
  const withoutComments =
    sql.replace(
      /--.*$/gm,
      ""
    );

  return (
    /(^|\s)BEGIN\s*;/i
      .test(withoutComments) ||
    /(^|\s)COMMIT\s*;/i
      .test(withoutComments)
  );
}
async function ensureTable(
  client
) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS
      schema_migrations (
        migration_name text
          PRIMARY KEY,

        checksum text
          NOT NULL,

        applied_at timestamptz
          NOT NULL DEFAULT NOW(),

        execution_ms integer
          NOT NULL DEFAULT 0,

        baseline boolean
          NOT NULL DEFAULT FALSE
      )
  `);
}

async function loadApplied(
  client
) {
  const result =
    await client.query(`
      SELECT
        migration_name,
        checksum,
        baseline,
        applied_at
      FROM schema_migrations
      ORDER BY migration_name
    `);

  return new Map(
    result.rows.map(
      row => [
        row.migration_name,
        row
      ]
    )
  );
}
async function main() {
  const client =
    await pool.connect();

  try {
    await client.query(
      `
      SELECT pg_advisory_lock(
        hashtext(
          'rithan_link_dm_schema_migrations'
        )
      )
      `
    );

    await ensureTable(
      client
    );

    const files =
      migrationFiles();

    const applied =
      await loadApplied(
        client
      );

    if (baselineExisting) {
      if (applied.size > 0) {
        throw new Error(
          "schema_migrations is not empty; refusing to baseline again"
        );
      }

      for (const name of files) {
        const content =
          fs.readFileSync(
            path.join(
              migrationsDir,
              name
            ),
            "utf8"
          );

        await client.query(
          `
          INSERT INTO schema_migrations (
            migration_name,
            checksum,
            execution_ms,
            baseline
          )
          VALUES ($1, $2, 0, TRUE)
          `,
          [
            name,
            checksum(content)
          ]
        );
      }

      console.log(
        `Baselined ${files.length} existing migration(s).`
      );

      return;
    }
    for (
      const [
        name,
        row
      ] of applied
    ) {
      const filePath =
        path.join(
          migrationsDir,
          name
        );

      if (
        !fs.existsSync(
          filePath
        )
      ) {
        throw new Error(
          `Applied migration file missing: ${name}`
        );
      }

      const currentChecksum =
        checksum(
          fs.readFileSync(
            filePath,
            "utf8"
          )
        );

      if (
        currentChecksum !==
        row.checksum
      ) {
        throw new Error(
          `Migration checksum drift detected: ${name}`
        );
      }
    }

    const pending =
      files.filter(
        name =>
          !applied.has(name)
      );

    if (!pending.length) {
      console.log(
        "No pending migrations."
      );

      return;
    }

    for (const name of pending) {
      const filePath =
        path.join(
          migrationsDir,
          name
        );

      const sql =
        fs.readFileSync(
          filePath,
          "utf8"
        );

      if (
        containsExplicitTransaction(
          sql
        )
      ) {
        throw new Error(
          `Pending migration must not contain BEGIN/COMMIT; runner provides the transaction: ${name}`
        );
      }

      const started =
        Date.now();

      await client.query(
        "BEGIN"
      );

      try {
        await client.query(sql);

        await client.query(
          `
          INSERT INTO schema_migrations (
            migration_name,
            checksum,
            execution_ms,
            baseline
          )
          VALUES ($1, $2, $3, FALSE)
          `,
          [
            name,
            checksum(sql),
            Date.now() -
              started
          ]
        );

        await client.query(
          "COMMIT"
        );

      } catch (error) {
        try {
          await client.query(
            "ROLLBACK"
          );
        } catch {}

        throw error;
      }

      console.log(
        `Applied migration: ${name}`
      );
    }

  } finally {
    try {
      await client.query(
        `
        SELECT pg_advisory_unlock(
          hashtext(
            'rithan_link_dm_schema_migrations'
          )
        )
        `
      );
    } catch {}

    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Migration failed:",
    error.message
  );

  process.exit(1);
});
