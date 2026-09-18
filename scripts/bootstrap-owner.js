require("dotenv").config();

const pool = require("../db");

const {
  hashPassword
} = require("../lib/password");

async function main() {
  const email =
    String(
      process.env.OWNER_EMAIL || ""
    )
      .trim()
      .toLowerCase();

  const displayName =
    String(
      process.env.OWNER_NAME || ""
    ).trim();

  const password =
    String(
      process.env.OWNER_PASSWORD || ""
    );

  const workspaceId =
    process.env.DEFAULT_WORKSPACE_ID;

  if (!email || !email.includes("@")) {
    throw new Error(
      "Valid OWNER_EMAIL required"
    );
  }

  if (!workspaceId) {
    throw new Error(
      "DEFAULT_WORKSPACE_ID is missing"
    );
  }

  const passwordHash =
    await hashPassword(password);

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    const workspace =
      await client.query(
        `
        SELECT id, name
        FROM workspaces
        WHERE id = $1
          AND status = 'active'
        LIMIT 1
        `,
        [workspaceId]
      );

    if (workspace.rowCount === 0) {
      throw new Error(
        "Workspace not found"
      );
    }

    let user =
      await client.query(
        `
        SELECT id
        FROM users
        WHERE LOWER(email) =
              LOWER($1)
        LIMIT 1
        `,
        [email]
      );

    let userId;

    if (user.rowCount === 0) {
      const inserted =
        await client.query(
          `
          INSERT INTO users (
            email,
            password_hash,
            display_name,
            status
          )
          VALUES (
            $1,
            $2,
            $3,
            'active'
          )
          RETURNING id
          `,
          [
            email,
            passwordHash,
            displayName || null
          ]
        );

      userId =
        inserted.rows[0].id;

    } else {
      userId =
        user.rows[0].id;

      await client.query(
        `
        UPDATE users
        SET
          password_hash = $1,
          display_name =
            COALESCE(
              NULLIF($2, ''),
              display_name
            ),
          status = 'active',
          updated_at = NOW()
        WHERE id = $3
        `,
        [
          passwordHash,
          displayName,
          userId
        ]
      );
    }

    await client.query(
      `
      INSERT INTO workspace_members (
        workspace_id,
        user_id,
        role
      )
      VALUES (
        $1,
        $2,
        'owner'
      )

      ON CONFLICT (
        workspace_id,
        user_id
      )
      DO UPDATE SET
        role = 'owner'
      `,
      [
        workspaceId,
        userId
      ]
    );

    await client.query("COMMIT");

    console.log(
      "Owner account ready:",
      {
        email,
        userId,
        workspaceId,
        workspace:
          workspace.rows[0].name
      }
    );

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(
      "Owner bootstrap failed:",
      error.message
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
