require("dotenv").config();

const {
  test,
  after
} = require("node:test");

const assert =
  require("node:assert/strict");

const pool =
  require("../db");

async function workspaceContext(
  client
) {
  const result =
    await client.query(`
      SELECT
        w.id AS workspace_id,
        ws.plan_code

      FROM workspaces w

      JOIN workspace_subscriptions ws
        ON ws.workspace_id = w.id

      WHERE
        w.status = 'active'

      ORDER BY
        w.created_at ASC

      LIMIT 1
    `);

  if (!result.rowCount) {
    throw new Error(
      "No active workspace with subscription found"
    );
  }

  return result.rows[0];
}

async function connectedAccount(
  client,
  workspaceId
) {
  const result =
    await client.query(
      `
      SELECT
        ia.id

      FROM instagram_accounts ia

      JOIN instagram_connections ic
        ON ic.instagram_account_id =
           ia.id

      WHERE
        ic.workspace_id = $1
        AND ic.status = 'connected'

      ORDER BY
        ic.connected_at DESC

      LIMIT 1
      `,
      [workspaceId]
    );

  if (!result.rowCount) {
    throw new Error(
      "No connected Instagram account found"
    );
  }

  return result.rows[0].id;
}

test(
  "database blocks an Instagram connection above the plan limit",
  async () => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const {
        workspace_id:
          workspaceId,
        plan_code:
          planCode
      } =
        await workspaceContext(
          client
        );

      const countResult =
        await client.query(
          `
          SELECT
            COUNT(*)::integer
              AS count

          FROM instagram_connections

          WHERE
            workspace_id = $1
            AND status IN (
              'connected',
              'reauth_required'
            )
          `,
          [workspaceId]
        );

      await client.query(
        `
        UPDATE plans
        SET
          max_instagram_accounts =
            $1
        WHERE code = $2
        `,
        [
          countResult.rows[0]
            .count,
          planCode
        ]
      );

      const account =
        await client.query(
          `
          INSERT INTO instagram_accounts (
            professional_account_id,
            username,
            account_type
          )
          VALUES (
            $1,
            'db_guard_test',
            'BUSINESS'
          )
          RETURNING id
          `,
          [
            `db-guard-${process.pid}-account`
          ]
        );

      await assert.rejects(
        client.query(
          `
          INSERT INTO instagram_connections (
            workspace_id,
            instagram_account_id,
            status
          )
          VALUES (
            $1,
            $2,
            'connected'
          )
          `,
          [
            workspaceId,
            account.rows[0].id
          ]
        ),
        error =>
          error.code ===
          "RL101"
      );

    } finally {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      client.release();
    }
  }
);

test(
  "database blocks automation activation above the plan limit",
  async () => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const {
        workspace_id:
          workspaceId,
        plan_code:
          planCode
      } =
        await workspaceContext(
          client
        );

      const accountId =
        await connectedAccount(
          client,
          workspaceId
        );

      const countResult =
        await client.query(
          `
          SELECT
            COUNT(*)::integer
              AS count

          FROM automations a

          JOIN instagram_connections ic
            ON ic.instagram_account_id =
               a.instagram_account_id
           AND ic.workspace_id = $1
           AND ic.status IN (
             'connected',
             'reauth_required'
           )

          WHERE a.active = TRUE
          `,
          [workspaceId]
        );

      const current =
        countResult.rows[0]
          .count;

      await client.query(
        `
        UPDATE plans
        SET
          max_active_automations =
            $1
        WHERE code = $2
        `,
        [
          current + 1,
          planCode
        ]
      );

      await client.query(
        `
        INSERT INTO automations (
          instagram_account_id,
          instagram_media_id,
          keyword,
          destination_url,
          dm_template,
          active
        )
        VALUES (
          $1,
          $2,
          $3,
          'https://example.com',
          'test',
          TRUE
        )
        `,
        [
          accountId,
          `db-guard-media-${process.pid}-1`,
          `DB_GUARD_${process.pid}_1`
        ]
      );

      await assert.rejects(
        client.query(
          `
          INSERT INTO automations (
            instagram_account_id,
            instagram_media_id,
            keyword,
            destination_url,
            dm_template,
            active
          )
          VALUES (
            $1,
            $2,
            $3,
            'https://example.com',
            'test',
            TRUE
          )
          `,
          [
            accountId,
            `db-guard-media-${process.pid}-2`,
            `DB_GUARD_${process.pid}_2`
          ]
        ),
        error =>
          error.code ===
          "RL301"
      );

    } finally {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      client.release();
    }
  }
);

test(
  "database blocks active automation writes for inactive subscriptions",
  async () => {
    const client =
      await pool.connect();

    try {
      await client.query(
        "BEGIN"
      );

      const {
        workspace_id:
          workspaceId
      } =
        await workspaceContext(
          client
        );

      const accountId =
        await connectedAccount(
          client,
          workspaceId
        );

      await client.query(
        `
        UPDATE workspace_subscriptions
        SET status = 'paused'
        WHERE workspace_id = $1
        `,
        [workspaceId]
      );

      await assert.rejects(
        client.query(
          `
          INSERT INTO automations (
            instagram_account_id,
            instagram_media_id,
            keyword,
            destination_url,
            dm_template,
            active
          )
          VALUES (
            $1,
            $2,
            $3,
            'https://example.com',
            'test',
            TRUE
          )
          `,
          [
            accountId,
            `db-subscription-guard-${process.pid}`,
            `DB_SUB_GUARD_${process.pid}`
          ]
        ),
        error =>
          error.code ===
          "RL002"
      );

    } finally {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      client.release();
    }
  }
);

after(async () => {
  await pool.end();
});
