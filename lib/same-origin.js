const SAFE_METHODS =
  new Set([
    "GET",
    "HEAD",
    "OPTIONS"
  ]);


function getAllowedOrigin() {
  const value =
    process.env.DASHBOARD_ORIGIN ||
    "https://api.rithantechnologies.com";

  return new URL(value).origin;
}


function getRequestOrigin(req) {
  const origin =
    req.get("origin");

  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      return null;
    }
  }

  const referer =
    req.get("referer");

  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }

  return null;
}


function requireSameOrigin(
  req,
  res,
  next
) {
  if (
    SAFE_METHODS.has(
      req.method
    )
  ) {
    return next();
  }

  let expectedOrigin;

  try {
    expectedOrigin =
      getAllowedOrigin();
  } catch (error) {
    console.error(
      "Invalid DASHBOARD_ORIGIN:",
      error.message
    );

    return res
      .status(500)
      .json({
        error:
          "origin_configuration_error"
      });
  }

  const requestOrigin =
    getRequestOrigin(req);

  if (
    !requestOrigin ||
    requestOrigin !==
      expectedOrigin
  ) {
    return res
      .status(403)
      .json({
        error:
          "csrf_origin_rejected"
      });
  }

  return next();
}


module.exports = {
  requireSameOrigin
};
