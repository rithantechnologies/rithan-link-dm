require("dotenv").config();

const pool = require("../db");
const { createOAuthState } = require("../lib/oauth-state");
const {
  buildAuthorizationUrl
} = require("../lib/instagram-oauth");

async function main() {
  const workspaceId = process.argv[2];

  if (!workspaceId) {
    throw new Error(
      "Usage: node scripts/create-instagram-oauth-url.js <workspace-id>"
    );
  }

  const workspace = await pool.query(
    `
    SELECT id, name, status
    FROM workspaces
    WHERE id = $1
    `,
    [workspaceId]
  );

  if (workspace.rows.length === 0) {
    throw new Error("Workspace not found");
  }

  if (workspace.rows[0].status !== "active") {
    throw new Error("Workspace is not active");
  }

  const oauthState = await createOAuthState(workspaceId);

  const authorizationUrl =
    buildAuthorizationUrl(oauthState.state);

  console.log("");
  console.log("Workspace:");
  console.log(workspace.rows[0].name);

  console.log("");
  console.log("OAuth state expires:");
  console.log(oauthState.expiresAt);

  console.log("");
  console.log("Open this URL in your browser:");
  console.log("");
  console.log(authorizationUrl);
  console.log("");
}

main()
  .catch((error) => {
    console.error("Failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
