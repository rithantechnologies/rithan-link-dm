function requireConfig(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

async function readJson(response) {
  const text = await response.text();

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Instagram API ${response.status}: ${JSON.stringify(body)}`
    );
  }

  return body;
}

async function exchangeCodeForToken(code) {
  const form = new URLSearchParams();

  form.set("client_id", requireConfig("INSTAGRAM_APP_ID"));
  form.set("client_secret", requireConfig("META_APP_SECRET"));
  form.set("grant_type", "authorization_code");
  form.set(
    "redirect_uri",
    requireConfig("INSTAGRAM_REDIRECT_URI")
  );
  form.set("code", code);

  const response = await fetch(
    "https://api.instagram.com/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  return readJson(response);
}

async function exchangeForLongLivedToken(shortToken) {
  const params = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: requireConfig("META_APP_SECRET"),
    access_token: shortToken
  });

  const response = await fetch(
    `https://graph.instagram.com/access_token?${params}`,
    {
      method: "GET"
    }
  );

  return readJson(response);
}

async function getInstagramProfile(accessToken) {
  const version =
    process.env.INSTAGRAM_API_VERSION || "v26.0";

  const params = new URLSearchParams({
    fields: "id,user_id,username,account_type",
    access_token: accessToken
  });

  const response = await fetch(
    `https://graph.instagram.com/${version}/me?${params}`
  );

  return readJson(response);
}

async function subscribeToComments(
  professionalAccountId,
  accessToken
) {
  const version =
    process.env.INSTAGRAM_API_VERSION || "v26.0";

  const params = new URLSearchParams({
    subscribed_fields: "comments"
  });

  const response = await fetch(
    `https://graph.instagram.com/${version}/${professionalAccountId}/subscribed_apps?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  return readJson(response);
}

module.exports = {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getInstagramProfile,
  subscribeToComments
};
