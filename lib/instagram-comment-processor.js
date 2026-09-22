const pool = require("../db");
const { decryptToken } = require("./token-crypto");
const {
  subscriptionAllowsUsage
} = require("./entitlements");

const {
  reserveDmSlot,
  commitDmSlot,
  releaseDmSlot
} = require("./dm-usage-quota");

const {
  checkDmSafety,
  recordDeliverySuccess,
  recordPlatformFailure
} = require("./instagram-safety");

const {
  classifyInstagramError,
  normalizeInstagramError
} = require("./instagram-api-error");

const API_VERSION =
  process.env.INSTAGRAM_API_VERSION || "v26.0";

async function getConnectedAccount(professionalAccountId) {
  const result = await pool.query(
    `
    SELECT
      ia.id AS instagram_account_id,
      ia.professional_account_id,
      ia.username,

      ic.id AS connection_id,
      ic.workspace_id,

      ic.token_ciphertext,
      ic.token_iv,
      ic.token_auth_tag,
      ic.token_key_version

    FROM instagram_accounts ia

    JOIN instagram_connections ic
      ON ic.instagram_account_id = ia.id

    WHERE ia.professional_account_id = $1
      AND ic.status = 'connected'

    LIMIT 1
    `,
    [professionalAccountId]
  );

  return result.rows[0] || null;
}

async function findAutomation(
  instagramAccountId,
  mediaId,
  commentText
) {
  const result = await pool.query(
    `
SELECT
  id,
  keyword,
  destination_url,
  dm_template,
  match_mode,
  public_reply_enabled,
  public_reply_template

    FROM automations

    WHERE instagram_account_id = $1
      AND instagram_media_id = $2
      AND active = TRUE
    `,
    [instagramAccountId, mediaId]
  );

  const comment =
    String(commentText || "")
      .trim()
      .toLowerCase();

  for (const automation of result.rows) {
    const keyword =
      String(automation.keyword)
        .trim()
        .toLowerCase();

    if (
      automation.match_mode === "exact" &&
      comment === keyword
    ) {
      return automation;
    }

    if (
      automation.match_mode === "contains" &&
      comment.includes(keyword)
    ) {
      return automation;
    }
  }

  return null;
}

async function markIgnored({
  commentId,
  accountId,
  mediaId,
  commenterId,
  username,
  text,
  reason
}) {
  await pool.query(
    `
    INSERT INTO processed_comments (
      comment_id,
      instagram_account_id,
      instagram_media_id,
      commenter_id,
      commenter_username,
      comment_text,
      status,
      ignore_reason,
      processed_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,
      'ignored',
      $7,
      NOW()
    )

    ON CONFLICT (comment_id)
    DO NOTHING
    `,
    [
      commentId,
      accountId,
      mediaId,
      commenterId,
      username,
      text,
      reason
    ]
  );
}

async function claimComment({
  commentId,
  accountId,
  automationId,
  mediaId,
  commenterId,
  username,
  text
}) {
  const result = await pool.query(
    `
    INSERT INTO processed_comments (
      comment_id,
      instagram_account_id,
      automation_id,
      instagram_media_id,
      commenter_id,
      commenter_username,
      comment_text,
      status
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      'processing'
    )

    ON CONFLICT (comment_id)
    DO UPDATE SET
      automation_id = EXCLUDED.automation_id,
      status = 'processing',
      failure_message = NULL
    WHERE processed_comments.status
      IN ('received','queued','processing','failed')

    RETURNING id
    `,
    [
      commentId,
      accountId,
      automationId,
      mediaId,
      commenterId,
      username,
      text
    ]
  );

  return result.rows.length === 1;
}

function renderMessage(automation, username) {
  return String(automation.dm_template)
    .replaceAll(
      "{{url}}",
      automation.destination_url
    )
    .replaceAll(
      "{{username}}",
      username || ""
    );
}

async function sendPrivateReply({
  professionalAccountId,
  token,
  commentId,
  message
}) {
  const response = await fetch(
    `https://graph.instagram.com/${API_VERSION}/${professionalAccountId}/messages`,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        recipient: {
          comment_id: commentId
        },

        message: {
          text: message
        }
      })
    }
  );

  const text = await response.text();

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }

  if (!response.ok) {
    throw classifyInstagramError(
      response,
      result
    );
  }

  return result;
}

async function processInstagramCommentJob(data) {
  const professionalAccountId =
    String(data.professionalAccountId || "");

  const value = data.value || {};

  const account =
    await getConnectedAccount(
      professionalAccountId
    );

  // Unknown or disconnected account:
  // finish successfully instead of poisoning the queue.
  if (!account) {
    console.log(
      "Worker ignored unknown Instagram account:",
      professionalAccountId
    );

    return {
      ignored: true,
      reason: "unknown_account"
    };
  }

  const commentId =
    value.id ? String(value.id) : null;

  const mediaId =
    value.media?.id
      ? String(value.media.id)
      : null;

  const commenterId =
    value.from?.id
      ? String(value.from.id)
      : null;

  const username =
    value.from?.username || null;

  const text =
    value.text || "";

  if (!commentId || !mediaId) {
    return {
      ignored: true,
      reason: "missing_comment_or_media_id"
    };
  }

  console.log("Worker processing comment:", {
    account: account.username,
    professionalAccountId,
    commentId,
    mediaId,
    username,
    text
  });

  // Instagram usernames are unique.
  // This prevents our own account comments/replies
  // from triggering its automations.
  if (
    username &&
    account.username &&
    username.toLowerCase() ===
      account.username.toLowerCase()
  ) {
    await markIgnored({
      commentId,
      accountId:
        account.instagram_account_id,
      mediaId,
      commenterId,
      username,
      text,
      reason: "own_account_comment"
    });

    return {
      ignored: true,
      reason: "own_account_comment"
    };
  }

  const automation =
    await findAutomation(
      account.instagram_account_id,
      mediaId,
      text
    );

  if (!automation) {
    await markIgnored({
      commentId,
      accountId:
        account.instagram_account_id,
      mediaId,
      commenterId,
      username,
      text,
      reason: "no_matching_automation"
    });

    console.log("Worker: no matching automation", {
      account: account.username,
      mediaId,
      text
    });

    return {
      ignored: true,
      reason: "no_matching_automation"
    };
  }

  const claimed =
    await claimComment({
      commentId,
      accountId:
        account.instagram_account_id,
      automationId:
        automation.id,
      mediaId,
      commenterId,
      username,
      text
    });

  if (!claimed) {
    console.log(
      "Worker: comment already completed/ignored:",
      commentId
    );

    return {
      ignored: true,
      reason: "already_processed"
    };
  }

  await pool.query(
    `
    INSERT INTO dm_logs (
      comment_id,
      instagram_account_id,
      automation_id,
      status,
      attempt_count
    )
    VALUES (
      $1,$2,$3,'sending',1
    )

    ON CONFLICT (comment_id)
    DO UPDATE SET
      status = 'sending',
      attempt_count =
        dm_logs.attempt_count + 1,
      failure_code = NULL,
      failure_message = NULL,
      updated_at = NOW()
    `,
    [
      commentId,
      account.instagram_account_id,
      automation.id
    ]
  );

  try {
    const token =
      decryptToken({
        ciphertext:
          account.token_ciphertext,

        iv:
          account.token_iv,

        authTag:
          account.token_auth_tag,

        keyVersion:
          account.token_key_version
      });

    const message =
      renderMessage(
        automation,
        username
      );

    const client =
      await pool.connect();

    let result;

    try {
      await client.query(
        "BEGIN"
      );

      // Serialize monthly quota decisions per workspace.
      // This prevents concurrent jobs from both consuming
      // the final available DM slot.
      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)
        )
        `,
        [
          String(
            account.workspace_id
          )
        ]
      );

      const entitlementResult =
        await client.query(
          `
          SELECT
            ws.plan_code,
            ws.status,

            p.monthly_dm_limit,

            COALESCE(
              usage.dm_sent_count,
              0
            )::bigint AS dm_sent_count

          FROM workspace_subscriptions ws

          JOIN plans p
            ON p.code =
               ws.plan_code

          LEFT JOIN workspace_usage_monthly usage
            ON usage.workspace_id =
               ws.workspace_id

           AND usage.period_start =
               date_trunc(
                 'month',
                 NOW()
               )::date

          WHERE
            ws.workspace_id = $1

          LIMIT 1
          `,
          [
            account.workspace_id
          ]
        );

      if (
        entitlementResult.rowCount === 0
      ) {
        await client.query(
          "ROLLBACK"
        );

        await pool.query(
          `
          UPDATE dm_logs
          SET
            status = 'skipped',
            failure_code =
              'subscription_not_found',
            failure_message =
              'Workspace subscription not found',
            updated_at = NOW()
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        await pool.query(
          `
          UPDATE processed_comments
          SET
            status = 'ignored',
            ignore_reason =
              'subscription_not_found',
            processed_at = NOW(),
            failure_message = NULL
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        return {
          ignored: true,
          reason:
            "subscription_not_found"
        };
      }

      const entitlement =
        entitlementResult.rows[0];

      if (
        !subscriptionAllowsUsage(
          entitlement.status
        )
      ) {
        await client.query(
          "ROLLBACK"
        );

        await pool.query(
          `
          UPDATE dm_logs
          SET
            status = 'skipped',
            failure_code =
              'subscription_inactive',
            failure_message =
              'Workspace subscription is inactive',
            updated_at = NOW()
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        await pool.query(
          `
          UPDATE processed_comments
          SET
            status = 'ignored',
            ignore_reason =
              'subscription_inactive',
            processed_at = NOW(),
            failure_message = NULL
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        return {
          ignored: true,
          reason:
            "subscription_inactive",
          status:
            entitlement.status
        };
      }

      const dmSentCount =
        Number(
          entitlement.dm_sent_count
        );

      const monthlyDmLimit =
        Number(
          entitlement.monthly_dm_limit
        );

      if (
        dmSentCount >=
        monthlyDmLimit
      ) {
        await client.query(
          "ROLLBACK"
        );

        await pool.query(
          `
          UPDATE dm_logs
          SET
            status = 'skipped',
            failure_code =
              'monthly_dm_limit_reached',
            failure_message =
              'Monthly DM plan limit reached',
            updated_at = NOW()
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        await pool.query(
          `
          UPDATE processed_comments
          SET
            status = 'ignored',
            ignore_reason =
              'monthly_dm_limit_reached',
            processed_at = NOW(),
            failure_message = NULL
          WHERE comment_id = $1
          `,
          [
            commentId
          ]
        );

        console.log(
          "Worker monthly DM limit reached:",
          {
            workspaceId:
              account.workspace_id,

            plan:
              entitlement.plan_code,

            current:
              dmSentCount,

            limit:
              monthlyDmLimit,

            commentId
          }
        );

        return {
          ignored: true,
          reason:
            "monthly_dm_limit_reached",

          plan:
            entitlement.plan_code,

          current:
            dmSentCount,

          limit:
            monthlyDmLimit
        };
      }

      const safety =
        await checkDmSafety(
          client,
          {
            accountId:
              account.instagram_account_id,
            automationId:
              automation.id,
            commenterId,
            commentId
          }
        );

      if (!safety.allowed) {
        await client.query("ROLLBACK");

        await pool.query(
          `UPDATE dm_logs
           SET status = 'skipped',
               failure_code = CASE
                 WHEN $2 = 'account_safety_paused'
                  AND failure_code LIKE 'instagram_%'
                   THEN failure_code
                 ELSE $2
               END,
               failure_message = CASE
                 WHEN $2 = 'account_safety_paused'
                  AND failure_message IS NOT NULL
                   THEN failure_message
                 ELSE $3
               END,
               updated_at = NOW()
           WHERE comment_id = $1`,
          [
            commentId,
            safety.reason,
            JSON.stringify(safety).slice(0, 2000)
          ]
        );

        await pool.query(
          `UPDATE processed_comments
           SET status = 'ignored',
               ignore_reason = $2,
               processed_at = NOW(),
               failure_message = NULL
           WHERE comment_id = $1`,
          [commentId, safety.reason]
        );

        return {
          ignored: true,
          reason: safety.reason,
          safety
        };
      }

      result =
        await sendPrivateReply({
          professionalAccountId,
          token,
          commentId,
          message
        });

      const sentUpdate =
        await client.query(
          `
          UPDATE dm_logs
          SET
            recipient_id = $1,
            message_id = $2,
            status = 'sent',
            sent_at = NOW(),
            failure_code = NULL,
            failure_message = NULL,
            updated_at = NOW()

          WHERE
            comment_id = $3
            AND status <> 'sent'

          RETURNING id
          `,
          [
            result.recipient_id || null,
            result.message_id || null,
            commentId
          ]
        );

      // Increment usage only when this job actually
      // transitions the DM log into sent.
      if (sentUpdate.rowCount === 1) {
        await client.query(
          `
          INSERT INTO workspace_usage_monthly (
            workspace_id,
            period_start,
            dm_sent_count
          )
          VALUES (
            $1,
            date_trunc(
              'month',
              NOW()
            )::date,
            1
          )

          ON CONFLICT (
            workspace_id,
            period_start
          )

          DO UPDATE SET
            dm_sent_count =
              workspace_usage_monthly
                .dm_sent_count + 1,

            updated_at =
              NOW()
          `,
          [
            account.workspace_id
          ]
        );
      }

      await recordDeliverySuccess(
        client,
        account.instagram_account_id
      );

      await client.query(
        `
        UPDATE processed_comments
        SET
          status = 'completed',
          processed_at = NOW(),
          failure_message = NULL
        WHERE comment_id = $1
        `,
        [
          commentId
        ]
      );

      await client.query(
        "COMMIT"
      );

    } catch (quotaError) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // Ignore rollback errors.
      }

      throw quotaError;

    } finally {
      client.release();
    }

    console.log("Worker private reply sent:", {
      account: account.username,
      commentId,
      recipientId:
        result.recipient_id,
      messageId:
        result.message_id
    });

    if (
      automation.public_reply_enabled &&
      automation.public_reply_template
    ) {
      await pool.query(
        `
        INSERT INTO public_reply_logs (
          comment_id,
          instagram_account_id,
          automation_id,
          status
        )
        VALUES ($1, $2, $3, 'pending')

        ON CONFLICT (comment_id)
        DO NOTHING
        `,
        [
          commentId,
          account.instagram_account_id,
          automation.id
        ]
      );
    }

    return {
      success: true,
      commentId,

      recipientId:
        result.recipient_id,

      publicReply:
        Boolean(
          automation.public_reply_enabled &&
          automation.public_reply_template
        )
    };

  } catch (error) {
    const normalized =
      normalizeInstagramError(error);

    try {
      await recordPlatformFailure(
        account.instagram_account_id,
        normalized
      );
    } catch (safetyError) {
      console.error(
        "Instagram safety failure recording failed:",
        safetyError.message
      );
    }

    if (normalized.category === "auth") {
      await pool.query(
        `UPDATE instagram_connections
         SET status = 'reauth_required',
             reauth_required_at = NOW(),
             last_error = $2,
             updated_at = NOW()
         WHERE instagram_account_id = $1
           AND status = 'connected'`,
        [
          account.instagram_account_id,
          normalized.message.slice(0, 2000)
        ]
      );
    }

    const failureCode =
      `instagram_${normalized.category}`;

    await pool.query(
      `
      UPDATE dm_logs
      SET
        status = 'failed',
        failure_code = $1,
        failure_message = $2,
        updated_at = NOW()
      WHERE comment_id = $3
      `,
      [
        failureCode,
        normalized.message,
        commentId
      ]
    );

    await pool.query(
      `
      UPDATE processed_comments
      SET
        status = 'failed',
        failure_message = $1,
        processed_at = NOW()
      WHERE comment_id = $2
      `,
      [
        normalized.message,
        commentId
      ]
    );

    if (!normalized.retryable) {
      return {
        failed: true,
        permanent: true,
        reason: failureCode,
        commentId
      };
    }

    // Only transient/network/rate-limit classes reach BullMQ retry.
    throw normalized;
  }
}

module.exports = {
  processInstagramCommentJob
};
