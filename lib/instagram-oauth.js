function getConfig() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

  if (!appId) {
    throw new Error("INSTAGRAM_APP_ID is not configured");
  }

  if (!redirectUri) {
    throw new Error("INSTAGRAM_REDIRECT_URI is not configured");
  }

  return {
    appId,
    redirectUri
  };
}

function buildAuthorizationUrl(state) {
  const { appId, redirectUri } = getConfig();

  const scopes = [
    "instagram_business_basic",
    "instagram_business_manage_comments",
    "instagram_business_manage_messages"
  ];

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(","),
    state,
    enable_fb_login: "0",
    force_authentication: "1"
  });

  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

module.exports = {
  buildAuthorizationUrl
};
