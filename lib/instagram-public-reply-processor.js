const pool = require("../db");

const {
  decryptToken
} = require("./token-crypto");

const API_VERSION =
  process.env.INSTAGRAM_API_VERSION || "v26.0";

async function processInstagramPublicReplyJob(data) {
  const commentId =
    String(data.commentId || "");

  if (!commentId) {
    return {
      ignored: true,
      reason: "missing_comment_id"
    };
  }

  const result = await pool.query(
    `
    SELECT
      prl.status,

      ia.username,
      ia.professional_account_id,

      ic.token_ciphertext,
      ic.token_iv,
      ic.token_auth_tag,
      ic.token_key_version,
      ic.workspace_id,

      ws.status AS subscription_status,

      a.public_reply_enabled,
      a.public_reply_template

    FROM public_reply_logs prl

    JOIN instagram_accounts ia
      ON ia.id = prl.instagram_account_id

    JOIN instagram_connections ic
      ON ic.instagram_account_id = ia.id
     AND ic.status = 'connected'

    JOIN workspace_subscriptions ws
      ON ws.workspace_id = ic.workspace_id

    JOIN automations a
      ON a.id = prl.automation_id

    WHERE prl.comment_id = $1

    LIMIT 1
    `,
    [commentId]
  );

  const row = result.rows[0];

  if (!row) {
    console.log(
      "Public reply: no eligible row:",
      commentId
    );

    return {
      ignored: true,
      reason: "no_eligible_public_reply"
    };
  }

  if (row.status === "sent") {
    return {
      ignored: true,
      reason: "already_sent"
    };
  }

  if (
    ![
      "active",
      "trialing"
    ].includes(
      String(
        row.subscription_status || ""
      )
    )
  ) {
    await pool.query(
      `
      UPDATE public_reply_logs
      SET
        status = 'skipped',
        failure_message =
          'Workspace subscription is inactive',
        updated_at = NOW()
      WHERE comment_id = $1
      `,
      [commentId]
    );

    return {
      ignored: true,
      reason: "subscription_inactive",
      status:
        row.subscription_status
    };
  }

  if (
    !row.public_reply_enabled ||
    !row.public_reply_template
  ) {
    await pool.query(
      `
      UPDATE public_reply_logs
      SET
        status = 'skipped',
        updated_at = NOW()
      WHERE comment_id = $1
      `,
      [commentId]
    );

    return {
      ignored: true,
      reason: "public_reply_disabled"
    };
  }

  const claimResult =
    await pool.query(
      `
      UPDATE public_reply_logs
      SET
        status = 'sending',
        attempt_count = attempt_count + 1,
        failure_message = NULL,
        updated_at = NOW()
      WHERE comment_id = $1
        AND status IN (
          'pending',
          'failed'
        )
      RETURNING id
      `,
      [commentId]
    );

  if (claimResult.rows.length === 0) {
    console.log(
      "Public reply not claimable:",
      commentId
    );

    return {
      ignored: true,
      reason: "already_claimed_or_sent"
    };
  }

  try {
    const token =
      decryptToken({
        ciphertext:
          row.token_ciphertext,

        iv:
          row.token_iv,

        authTag:
          row.token_auth_tag,

        keyVersion:
          row.token_key_version
      });

    const response =
      await fetch(
        `https://graph.instagram.com/${API_VERSION}/${commentId}/replies`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            message:
              row.public_reply_template
          })
        }
      );

    const responseText =
      await response.text();

    let body;

    try {
      body = JSON.parse(responseText);
    } catch {
      body = {
        raw: responseText.slice(0, 1000)
      };
    }

    if (!response.ok) {
      throw new Error(
        `Instagram public reply HTTP ${response.status}: ${JSON.stringify(body)}`
      );
    }

    await pool.query(
      `
      UPDATE public_reply_logs
      SET
        status = 'sent',
        reply_comment_id = $1,
        sent_at = NOW(),
        updated_at = NOW(),
        failure_message = NULL
      WHERE comment_id = $2
      `,
      [
        body.id || null,
        commentId
      ]
    );

    console.log(
      "Worker public reply sent:",
      {
        account: row.username,
        commentId,
        replyCommentId:
          body.id || null
      }
    );

    return {
      success: true,
      commentId,
      replyCommentId:
        body.id || null
    };

  } catch (error) {
    await pool.query(
      `
      UPDATE public_reply_logs
      SET
        status = 'failed',
        failure_message = $1,
        updated_at = NOW()
      WHERE comment_id = $2
      `,
      [
        String(error.message)
          .slice(0, 2000),

        commentId
      ]
    );

    throw error;
  }
}

module.exports = {
  processInstagramPublicReplyJob
};
