const express = require("express");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const {
  getWorkspaceEntitlements
} = require("../lib/entitlements");

const router =
  express.Router();

router.use(requireAuth);


// --------------------------------------------------
// GET /api/activity
// --------------------------------------------------

router.get(
  "/",
  async (req, res) => {
    try {
      const entitlements =
        await getWorkspaceEntitlements(
          req.auth.workspaceId
        );

      if (!entitlements) {
        return res.status(404).json({
          error:
            "subscription_not_found"
        });
      }

      const historyDays =
        Math.max(
          1,
          Number(
            entitlements.activityHistoryDays
          ) || 7
        );

      const limit =
        Math.min(
          Math.max(
            Number(req.query.limit) || 100,
            1
          ),
          250
        );

      const result =
        await pool.query(
          `
          SELECT
            pc.comment_id,
            pc.instagram_media_id,

            pc.commenter_id,
            pc.commenter_username,
            pc.comment_text,
            pc.comment_created_at,
            pc.received_at,

            pc.status AS comment_status,
            pc.ignore_reason,
            pc.failure_message
              AS comment_failure_message,

            ia.id
              AS instagram_account_id,

            ia.username
              AS instagram_username,

            a.id
              AS automation_id,

            a.keyword
              AS automation_keyword,

            dl.status
              AS dm_status,

            dl.attempt_count
              AS dm_attempt_count,

            dl.message_id
              AS dm_message_id,

            dl.failure_code
              AS dm_failure_code,

            dl.failure_message
              AS dm_failure_message,

            dl.sent_at
              AS dm_sent_at,

            pr.status
              AS public_reply_status,

            pr.attempt_count
              AS public_reply_attempt_count,

            pr.reply_comment_id,

            pr.failure_message
              AS public_reply_failure_message,

            pr.sent_at
              AS public_reply_sent_at

          FROM processed_comments pc

          JOIN instagram_accounts ia
            ON ia.id =
               pc.instagram_account_id

          JOIN LATERAL (
            SELECT
              ic.id
            FROM instagram_connections ic

            WHERE
              ic.instagram_account_id = ia.id
              AND ic.workspace_id = $1

            ORDER BY
              ic.connected_at DESC,
              ic.created_at DESC

            LIMIT 1
          ) workspace_connection
            ON TRUE

          LEFT JOIN automations a
            ON a.id =
               pc.automation_id

          LEFT JOIN dm_logs dl
            ON dl.comment_id =
               pc.comment_id

          LEFT JOIN public_reply_logs pr
            ON pr.comment_id =
               pc.comment_id

          WHERE
            pc.received_at >=
              NOW() - (
                $2::integer *
                INTERVAL '1 day'
              )

          ORDER BY
            pc.received_at DESC

          LIMIT $3
          `,
          [
            req.auth.workspaceId,
            historyDays,
            limit
          ]
        );

      const rows =
        result.rows;

      const summary = {
        total:
          rows.length,

        dmSent:
          rows.filter(
            row =>
              row.dm_status === "sent"
          ).length,

        dmFailed:
          rows.filter(
            row =>
              row.dm_status === "failed"
          ).length,

        publicRepliesSent:
          rows.filter(
            row =>
              row.public_reply_status ===
              "sent"
          ).length
      };

      return res.json({
        activity:
          rows,

        summary,

        retention: {
          plan:
            entitlements.planCode,

          historyDays
        }
      });

    } catch (error) {
      console.error(
        "Activity lookup failed:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            "activity_lookup_failed"
        });
    }
  }
);


module.exports = router;
