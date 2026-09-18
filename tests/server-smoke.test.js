const {
  test,
  before,
  after
} = require("node:test");

const assert =
  require("node:assert/strict");

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

let child;
let stdout = "";
let stderr = "";

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
        "/usr/bin/node",
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
});

after(async () => {
  if (
    !child ||
    child.exitCode !== null
  ) {
    return;
  }

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
