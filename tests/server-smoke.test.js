const {
  test,
  before,
  after
} = require("node:test");

const assert =
  require("node:assert/strict");

require("dotenv").config();

const crypto =
  require("node:crypto");

const pool =
  require("../db");

const {
  spawn
} = require("node:child_process");

const path =
  require("node:path");

const appRoot =
  path.join(
    __dirname,
    ".."
  );

const port =
  Number(
    process.env.SMOKE_PORT ||
    3195
  );

const base =
  `http://127.0.0.1:${port}`;

const allowedOrigin =
  new URL(
    process.env.DASHBOARD_ORIGIN ||
    "https://api.rithantechnologies.com"
  ).origin;

let child;
let stdout = "";
let stderr = "";
let adminSessionId = null;
let adminCookie = "";

function wait(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

async function waitForServer() {
  const deadline =
    Date.now() + 12000;

  while (
    Date.now() < deadline
  ) {
    try {
      const response =
        await fetch(
          `${base}/health`
        );

      if (response.ok) {
        return;
      }
    } catch {}

    await wait(150);
  }

  throw new Error(
    "Temporary API did not become ready"
  );
}

before(async () => {
  child =
    spawn(
      process.env
        .PRODUCTION_NODE ||
        process.execPath,
      [
        "server.js"
      ],
      {
        cwd:
          appRoot,

        env: {
          ...process.env,
          PORT:
            String(port)
        },

        stdio: [
          "ignore",
          "pipe",
          "pipe"
        ]
      }
    );

  child.stdout.on(
    "data",
    chunk => {
      stdout +=
        chunk.toString();
    }
  );

  child.stderr.on(
    "data",
    chunk => {
      stderr +=
        chunk.toString();
    }
  );

  await waitForServer();

  const admin =
    await pool.query(
      `
      SELECT
        u.id AS user_id,
        wm.workspace_id

      FROM system_admins sa

      JOIN users u
        ON u.id = sa.user_id

      JOIN workspace_members wm
        ON wm.user_id = u.id

      ORDER BY
        wm.created_at ASC

      LIMIT 1
      `
    );

  assert.equal(
    admin.rowCount,
    1,
    "Smoke test requires one system admin"
  );

  const token =
    crypto
      .randomBytes(32)
      .toString("hex");

  const tokenHash =
    crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

  const session =
    await pool.query(
      `
      INSERT INTO user_sessions (
        user_id,
        active_workspace_id,
        session_token_hash,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        NOW() + INTERVAL '15 minutes'
      )
      RETURNING id
      `,
      [
        admin.rows[0].user_id,
        admin.rows[0].workspace_id,
        tokenHash
      ]
    );

  adminSessionId =
    session.rows[0].id;

  adminCookie =
    `${
      process.env.SESSION_COOKIE_NAME ||
      "rithan_session"
    }=${token}`;
});

after(async () => {
  try {
    if (
      child &&
      child.exitCode === null
    ) {
      const exited =
        new Promise(
          (resolve, reject) => {
            const timer =
              setTimeout(
                () => {
                  reject(
                    new Error(
                      "Temporary API did not shut down cleanly"
                    )
                  );
                },
                15000
              );

            child.once(
              "exit",
              (code, signal) => {
                clearTimeout(
                  timer
                );

                resolve({
                  code,
                  signal
                });
              }
            );
          }
        );

      child.kill("SIGTERM");

      const result =
        await exited;

      assert.equal(
        result.code,
        0,
        [
          "Temporary API exit code was not zero.",
          stdout,
          stderr
        ].join("\n")
      );
    }

  } finally {
    if (adminSessionId) {
      await pool.query(
        `
        DELETE FROM user_sessions
        WHERE id = $1
        `,
        [adminSessionId]
      );
    }

    await pool.end();
  }
});

test(
  "health and readiness succeed",
  async () => {
    const health =
      await fetch(
        `${base}/health`
      );

    assert.equal(
      health.status,
      200
    );

    assert.equal(
      (
        await health.json()
      ).status,
      "ok"
    );

    const ready =
      await fetch(
        `${base}/ready`
      );

    assert.equal(
      ready.status,
      200
    );

    assert.deepEqual(
      await ready.json(),
      {
        status: "ready",
        database: "ok",
        redis: "ok"
      }
    );
  }
);

test(
  "dashboard security headers are present",
  async () => {
    const response =
      await fetch(
        `${base}/dashboard/`,
        {
          headers: {
            "x-forwarded-proto":
              "https"
          }
        }
      );

    assert.equal(
      response.status,
      200
    );

    assert.equal(
      response.headers.get(
        "x-frame-options"
      ),
      "DENY"
    );

    assert.equal(
      response.headers.get(
        "x-content-type-options"
      ),
      "nosniff"
    );

    assert.match(
      response.headers.get(
        "content-security-policy"
      ) || "",
      /default-src 'self'/
    );

    assert.match(
      response.headers.get(
        "strict-transport-security"
      ) || "",
      /max-age=31536000/
    );

    assert.equal(
      response.headers.has(
        "x-powered-by"
      ),
      false
    );
  }
);

test(
  "admin console is served",
  async () => {
    const response =
      await fetch(
        `${base}/admin/`
      );

    assert.equal(
      response.status,
      200
    );
  }
);

test(
  "system admin can load operational APIs",
  async () => {
    const headers = {
      cookie:
        adminCookie
    };

    const me =
      await fetch(
        `${base}/api/auth/me`,
        {
          headers
        }
      );

    assert.equal(
      me.status,
      200
    );

    assert.equal(
      (
        await me.json()
      ).user
        .isSystemAdmin,
      true
    );

    for (
      const path of [
        "/api/admin/overview",
        "/api/admin/customer-requests?status=pending&limit=5",
        "/api/admin/workspaces?limit=5",
        "/api/admin/errors?limit=5",
        "/api/admin/system",
        "/api/auth/sessions"
      ]
    ) {
      const response =
        await fetch(
          `${base}${path}`,
          {
            headers
          }
        );

      assert.equal(
        response.status,
        200,
        path
      );
    }
  }
);

test(
  "Instagram safety and preflight APIs are readable",
  async () => {
    const headers = {
      cookie:
        adminCookie
    };

    const accountsResponse =
      await fetch(
        `${base}/api/instagram/accounts`,
        {
          headers
        }
      );

    assert.equal(
      accountsResponse.status,
      200
    );

    const accountsBody =
      await accountsResponse.json();

    assert.equal(
      Array.isArray(
        accountsBody.accounts
      ),
      true
    );

    if (
      accountsBody.accounts.length === 0
    ) {
      return;
    }

    const accountId =
      accountsBody.accounts[0].id;

    const safety =
      await fetch(
        `${base}/api/instagram/accounts/${accountId}/safety`,
        {
          headers
        }
      );

    assert.equal(
      safety.status,
      200
    );

    const safetyBody =
      await safety.json();

    assert.ok(
      safetyBody.policy
    );

    assert.ok(
      safetyBody.effectiveDmLimits
    );

    const preflight =
      await fetch(
        `${base}/api/instagram/accounts/${accountId}/preflight`,
        {
          headers
        }
      );

    assert.equal(
      preflight.status,
      200
    );

    const preflightBody =
      await preflight.json();

    assert.equal(
      Array.isArray(
        preflightBody.checks
      ),
      true
    );

    const metaAccess =
      preflightBody.checks.find(
        check =>
          check.id ===
          "meta_external_customer_access_confirmed"
      );

    assert.ok(metaAccess);

    assert.equal(
      metaAccess.pass,
      false
    );
  }
);

test(
  "unauthenticated API access is rejected and not cached",
  async () => {
    const response =
      await fetch(
        `${base}/api/billing/usage`
      );

    assert.equal(
      response.status,
      401
    );

    assert.equal(
      response.headers.get(
        "cache-control"
      ),
      "no-store"
    );
  }
);

test(
  "same-origin protection blocks mutation without origin",
  async () => {
    const response =
      await fetch(
        `${base}/api/auth/logout`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },
          body: "{}"
        }
      );

    assert.equal(
      response.status,
      403
    );
  }
);

test(
  "malformed JSON is rejected",
  async () => {
    const response =
      await fetch(
        `${base}/api/auth/logout`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },
          body: "{bad"
        }
      );

    assert.equal(
      response.status,
      400
    );

    assert.equal(
      (
        await response.json()
      ).error,
      "invalid_json"
    );
  }
);

test(
  "oversized JSON is rejected",
  async () => {
    const response =
      await fetch(
        `${base}/api/auth/logout`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },
          body:
            JSON.stringify({
              payload:
                "x".repeat(
                  600 * 1024
                )
            })
        }
      );

    assert.equal(
      response.status,
      413
    );

    assert.equal(
      (
        await response.json()
      ).error,
      "request_body_too_large"
    );
  }
);

test(
  "invalid Meta webhook signature is rejected before queueing",
  async () => {
    const response =
      await fetch(
        `${base}/webhooks/instagram`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json"
          },
          body:
            JSON.stringify({
              object:
                "instagram",
              entry: []
            })
        }
      );

    assert.equal(
      response.status,
      401
    );
  }
);

test(
  "customer onboarding public endpoints validate input safely",
  async () => {
    const headers = {
      "content-type": "application/json",
      origin: allowedOrigin
    };

    const requestAccess =
      await fetch(
        `${base}/api/auth/request-access`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            email: "invalid",
            workspaceName: ""
          })
        }
      );

    assert.equal(
      requestAccess.status,
      400
    );

    const setupLookup =
      await fetch(
        `${base}/api/auth/setup-account/validate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            token: "not-a-real-token"
          })
        }
      );

    assert.equal(
      setupLookup.status,
      404
    );
  }
);

test(
  "system admin approval rejects an unknown request",
  async () => {
    const response =
      await fetch(
        `${base}/api/admin/customer-requests/00000000-0000-0000-0000-000000000000/approve`,
        {
          method: "POST",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
            origin: allowedOrigin
          },
          body: JSON.stringify({
            planCode: "free"
          })
        }
      );

    assert.equal(
      response.status,
      404
    );
  }
);
