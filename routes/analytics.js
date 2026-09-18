const express = require("express");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const {
  getWorkspaceEntitlements
} = require("../lib/entitlements");

const router = express.Router();

router.use(requireAuth);


function getRange(value) {
  switch (value) {
    case "24h":
      return {
        key: "24h",
        days: 1
      };

    case "30d":
      return {
        key: "30d",
        days: 30
      };

    case "7d":
    default:
      return {
        key: "7d",
        days: 7
      };
  }
}


// --------------------------------------------------
// GET /api/analytics?range=7d
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const requestedRange =
      getRange(req.query.range);

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

    const range = {
      key:
        requestedRange.key === "30d" &&
        historyDays < 30
          ? "7d"
          : requestedRange.key,

      days:
        Math.min(
          requestedRange.days,
          historyDays
        )
    };

    let startAt;

    if (range.key === "24h") {
      startAt =
        new Date(
          Date.now() -
          24 * 60 * 60 * 1000
        );
    } else {
      startAt = new Date();

      startAt.setHours(
        0,
        0,
        0,
        0
      );

      startAt.setDate(
        startAt.getDate() -
        (range.days - 1)
      );
    }

    const workspaceId =
      req.auth.workspaceId;

    const chartDays =
      range.key === "24h"
        ? 2
        : range.days;


    // ----------------------------------------------
    // Summary
    // ----------------------------------------------

    const summaryResult =
      await pool.query(
        `
        SELECT
          (
            SELECT COUNT(*)
            FROM processed_comments pc

            WHERE
              pc.received_at >= $2

              AND EXISTS (
                SELECT 1
                FROM instagram_connections ic

                WHERE
                  ic.instagram_account_id =
                    pc.instagram_account_id

                  AND ic.workspace_id = $1
              )
          )::int
            AS comments_received,

          (
            SELECT COUNT(*)
            FROM dm_logs dl

            WHERE
              dl.created_at >= $2
              AND dl.status = 'sent'

              AND EXISTS (
                SELECT 1
                FROM instagram_connections ic

                WHERE
                  ic.instagram_account_id =
                    dl.instagram_account_id

                  AND ic.workspace_id = $1
              )
          )::int
            AS dm_sent,

          (
            SELECT COUNT(*)
            FROM dm_logs dl

            WHERE
              dl.created_at >= $2
              AND dl.status = 'failed'

              AND EXISTS (
                SELECT 1
                FROM instagram_connections ic

                WHERE
                  ic.instagram_account_id =
                    dl.instagram_account_id

                  AND ic.workspace_id = $1
              )
          )::int
            AS dm_failed,

          (
            SELECT COUNT(*)
            FROM public_reply_logs pr

            WHERE
              pr.created_at >= $2
              AND pr.status = 'sent'

              AND EXISTS (
                SELECT 1
                FROM instagram_connections ic

                WHERE
                  ic.instagram_account_id =
                    pr.instagram_account_id

                  AND ic.workspace_id = $1
              )
          )::int
            AS public_replies_sent
        `,
        [
          workspaceId,
          startAt
        ]
      );

    const rawSummary =
      summaryResult.rows[0];

    const dmSent =
      Number(rawSummary.dm_sent || 0);

    const dmFailed =
      Number(rawSummary.dm_failed || 0);

    const attempted =
      dmSent + dmFailed;

    const successRate =
      attempted > 0
        ? Number(
            (
              dmSent /
              attempted *
              100
            ).toFixed(1)
          )
        : null;


    // ----------------------------------------------
    // Daily series
    // ----------------------------------------------

    const dailyResult =
      await pool.query(
        `
        WITH days AS (
          SELECT
            generate_series(
              CURRENT_DATE -
                ($3::int - 1),
              CURRENT_DATE,
              INTERVAL '1 day'
            )::date AS day
        ),

        comments AS (
          SELECT
            DATE(pc.received_at) AS day,
            COUNT(*)::int AS count

          FROM processed_comments pc

          WHERE
            pc.received_at >= $2

            AND EXISTS (
              SELECT 1
              FROM instagram_connections ic

              WHERE
                ic.instagram_account_id =
                  pc.instagram_account_id

                AND ic.workspace_id = $1
            )

          GROUP BY
            DATE(pc.received_at)
        ),

        dms AS (
          SELECT
            DATE(dl.created_at) AS day,
            COUNT(*) FILTER (
              WHERE dl.status = 'sent'
            )::int AS sent,

            COUNT(*) FILTER (
              WHERE dl.status = 'failed'
            )::int AS failed

          FROM dm_logs dl

          WHERE
            dl.created_at >= $2

            AND EXISTS (
              SELECT 1
              FROM instagram_connections ic

              WHERE
                ic.instagram_account_id =
                  dl.instagram_account_id

                AND ic.workspace_id = $1
            )

          GROUP BY
            DATE(dl.created_at)
        )

        SELECT
          days.day,

          COALESCE(
            comments.count,
            0
          )::int AS comments,

          COALESCE(
            dms.sent,
            0
          )::int AS dm_sent,

          COALESCE(
            dms.failed,
            0
          )::int AS dm_failed

        FROM days

        LEFT JOIN comments
          ON comments.day =
             days.day

        LEFT JOIN dms
          ON dms.day =
             days.day

        ORDER BY
          days.day ASC
        `,
        [
          workspaceId,
          startAt,
          chartDays
        ]
      );


    // ----------------------------------------------
    // Top automations
    // ----------------------------------------------

    const automationResult =
      await pool.query(
        `
        SELECT
          a.id,
          a.keyword,

          ia.username
            AS instagram_username,

          COUNT(dl.id) FILTER (
            WHERE dl.status = 'sent'
          )::int
            AS dm_sent,

          COUNT(dl.id) FILTER (
            WHERE dl.status = 'failed'
          )::int
            AS dm_failed

        FROM automations a

        JOIN instagram_accounts ia
          ON ia.id =
             a.instagram_account_id

        LEFT JOIN dm_logs dl
          ON dl.automation_id =
             a.id

          AND dl.created_at >= $2

        WHERE
          EXISTS (
            SELECT 1
            FROM instagram_connections ic

            WHERE
              ic.instagram_account_id =
                a.instagram_account_id

              AND ic.workspace_id = $1
          )

        GROUP BY
          a.id,
          a.keyword,
          ia.username

        ORDER BY
          dm_sent DESC,
          a.keyword ASC

        LIMIT 10
        `,
        [
          workspaceId,
          startAt
        ]
      );


    // ----------------------------------------------
    // Performance by Instagram account
    // ----------------------------------------------

    const accountResult =
      await pool.query(
        `
        SELECT
          ia.id,
          ia.username,

          COUNT(DISTINCT pc.comment_id)::int
            AS comments_received,

          COUNT(DISTINCT dl.id) FILTER (
            WHERE dl.status = 'sent'
          )::int
            AS dm_sent,

          COUNT(DISTINCT dl.id) FILTER (
            WHERE dl.status = 'failed'
          )::int
            AS dm_failed

        FROM instagram_accounts ia

        JOIN instagram_connections ic
          ON ic.instagram_account_id =
             ia.id

          AND ic.workspace_id = $1

        LEFT JOIN processed_comments pc
          ON pc.instagram_account_id =
             ia.id

          AND pc.received_at >= $2

        LEFT JOIN dm_logs dl
          ON dl.instagram_account_id =
             ia.id

          AND dl.created_at >= $2

        GROUP BY
          ia.id,
          ia.username

        ORDER BY
          dm_sent DESC,
          ia.username ASC
        `,
        [
          workspaceId,
          startAt
        ]
      );


    return res.json({
      range:
        range.key,

      requestedRange:
        requestedRange.key,

      retention: {
        plan:
          entitlements.planCode,

        historyDays,

        limitedByPlan:
          requestedRange.days >
          historyDays
      },

      from:
        startAt.toISOString(),

      summary: {
        commentsReceived:
          Number(
            rawSummary.comments_received || 0
          ),

        dmSent,

        dmFailed,

        dmSuccessRate:
          successRate,

        publicRepliesSent:
          Number(
            rawSummary.public_replies_sent || 0
          )
      },

      daily:
        dailyResult.rows,

      topAutomations:
        automationResult.rows,

      accounts:
        accountResult.rows
    });

  } catch (error) {
    console.error(
      "Analytics lookup failed:",
      error.message
    );

    return res
      .status(500)
      .json({
        error:
          "analytics_lookup_failed"
      });
  }
});


module.exports = router;
