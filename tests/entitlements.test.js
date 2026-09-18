const test = require("node:test");
const assert = require("node:assert/strict");

const {
  subscriptionAllowsUsage
} = require("../lib/entitlements");

test(
  "active and trialing subscriptions are allowed",
  () => {
    assert.equal(
      subscriptionAllowsUsage(
        "active"
      ),
      true
    );

    assert.equal(
      subscriptionAllowsUsage(
        "trialing"
      ),
      true
    );
  }
);

test(
  "inactive subscription states are blocked",
  () => {
    for (
      const status of [
        "past_due",
        "paused",
        "canceled",
        "",
        null,
        undefined
      ]
    ) {
      assert.equal(
        subscriptionAllowsUsage(
          status
        ),
        false,
        String(status)
      );
    }
  }
);
