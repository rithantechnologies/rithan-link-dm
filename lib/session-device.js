function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua)) return "Opera";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  return "Browser";
}

function detectOs(ua) {
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iOS/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown OS";
}

function sessionMetadata(req) {
  const userAgent = String(req.get("user-agent") || "").slice(0, 1000);
  const browser = detectBrowser(userAgent);
  const os = detectOs(userAgent);
  return {
    userAgent: userAgent || null,
    ipAddress: String(req.ip || req.socket?.remoteAddress || "").slice(0, 128) || null,
    deviceLabel: `${browser} on ${os}`
  };
}

module.exports = {
  sessionMetadata
};
