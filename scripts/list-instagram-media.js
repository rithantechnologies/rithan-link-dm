require("dotenv").config();

const pool = require("../db");
const { decryptToken } = require("../lib/token-crypto");

async function main() {
  const username = process.argv[2];

  if (!username) {
    throw new Error(
      "Usage: node scripts/list-instagram-media.js <instagram-username>"
    );
  }

  const result = await pool.query(
    `
    SELECT
      ia.username,
      ia.professional_account_id,
      ic.token_ciphertext,
      ic.token_iv,
      ic.token_auth_tag,
      ic.token_key_version
    FROM instagram_accounts ia
    JOIN instagram_connections ic
      ON ic.instagram_account_id = ia.id
    WHERE LOWER(ia.username) = LOWER($1)
      AND ic.status = 'connected'
    LIMIT 1
    `,
    [username]
  );

  if (result.rows.length === 0) {
    throw new Error("Connected Instagram account not found");
  }

  const row = result.rows[0];

  const accessToken = decryptToken({
    ciphertext: row.token_ciphertext,
    iv: row.token_iv,
    authTag: row.token_auth_tag,
    keyVersion: row.token_key_version
  });

  const version =
    process.env.INSTAGRAM_API_VERSION || "v26.0";

  const params = new URLSearchParams({
    fields: "id,caption,media_type,permalink",
    access_token: accessToken
  });

  const response = await fetch(
    `https://graph.instagram.com/${version}/me/media?${params}`
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(
      `Instagram API error: ${JSON.stringify(body)}`
    );
  }

  console.log("");
  console.log(`Media for @${row.username}`);
  console.log(`Professional ID: ${row.professional_account_id}`);
  console.log("");

  for (const item of body.data || []) {
    console.log("---------------------------------------");
    console.log("Media ID :", item.id);
    console.log("Type     :", item.media_type);
    console.log("URL      :", item.permalink);

    if (item.caption) {
      const shortCaption =
        item.caption.replace(/\s+/g, " ").slice(0, 100);

      console.log("Caption  :", shortCaption);
    }
  }
}

main()
  .catch((err) => {
    console.error("Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
