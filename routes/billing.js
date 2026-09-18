const express = require("express");

const {
  requireAuth
} = require("../lib/auth");

const {
  getWorkspaceEntitlements,
  getWorkspaceInstagramAccountCount,
  getWorkspaceActiveAutomationCount
} = require("../lib/entitlements");

const router = express.Router();

router.use(requireAuth);


// --------------------------------------------------
// GET /api/billing/usage
// --------------------------------------------------

router.get(
  "/usage",

  async (req, res) => {
    try {
      const workspaceId =
        req.auth.workspaceId;

      const [
        entitlements,
        instagramAccounts,
        activeAutomations
      ] =
        await Promise.all([
          getWorkspaceEntitlements(
            workspaceId
          ),

          getWorkspaceInstagramAccountCount(
            workspaceId
          ),

          getWorkspaceActiveAutomationCount(
            workspaceId
          )
        ]);

      if (!entitlements) {
        return res.status(404).json({
          error:
            "subscription_not_found"
        });
      }

      return res.json({
        plan: {
          code:
            entitlements.planCode,

          name:
            entitlements.planName,

          status:
            entitlements.status,

          currentPeriodStart:
            entitlements
              .currentPeriodStart,

          currentPeriodEnd:
            entitlements
              .currentPeriodEnd
        },

        limits: {
          instagramAccounts:
            entitlements
              .maxInstagramAccounts,

          activeAutomations:
            entitlements
              .maxActiveAutomations,

          monthlyDm:
            entitlements
              .monthlyDmLimit,

          activityHistoryDays:
            entitlements
              .activityHistoryDays
        },

        usage: {
          instagramAccounts,

          activeAutomations,

          monthlyDm:
            entitlements
              .monthlyDmSent
        },

        remaining: {
          instagramAccounts:
            Math.max(
              0,
              entitlements
                .maxInstagramAccounts -
                instagramAccounts
            ),

          activeAutomations:
            Math.max(
              0,
              entitlements
                .maxActiveAutomations -
                activeAutomations
            ),

          monthlyDm:
            entitlements
              .monthlyDmRemaining
        },

        limitReached: {
          instagramAccounts:
            instagramAccounts >=
            entitlements
              .maxInstagramAccounts,

          activeAutomations:
            activeAutomations >=
            entitlements
              .maxActiveAutomations,

          monthlyDm:
            entitlements
              .monthlyDmLimitReached
        },

        commercial: {
          mode:
            process.env.BILLING_PURCHASE_MODE ||
            "private_beta",

          checkoutEnabled:
            Boolean(
              process.env.BILLING_CHECKOUT_URL
            ),

          contactUrl:
            process.env.BILLING_CONTACT_URL ||
            null,

          purchaseUrl:
            process.env.BILLING_CHECKOUT_URL ||
            process.env.BILLING_CONTACT_URL ||
            null
        }
      });

    } catch (error) {
      console.error(
        "Billing usage failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


module.exports = router;
