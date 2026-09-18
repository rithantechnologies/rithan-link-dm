const crypto = require("crypto");

function getEncryptionKey() {
  const hexKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!hexKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  }

  const key = Buffer.from(hexKey, "hex");

  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)"
    );
  }

  return key;
}

function getKeyVersion() {
  const version = Number(process.env.TOKEN_ENCRYPTION_KEY_VERSION || 1);

  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Invalid TOKEN_ENCRYPTION_KEY_VERSION");
  }

  return version;
}

function encryptToken(plaintext) {
  if (!plaintext) {
    throw new Error("Token cannot be empty");
  }

  const key = getEncryptionKey();

  // 96-bit IV is standard for AES-GCM
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
  );

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: getKeyVersion()
  };
}

function decryptToken({
  ciphertext,
  iv,
  authTag,
  keyVersion
}) {
  if (
    !ciphertext ||
    !iv ||
    !authTag
  ) {
    throw new Error("Incomplete encrypted token");
  }

  if (Number(keyVersion) !== getKeyVersion()) {
    throw new Error(
      `Unsupported encryption key version: ${keyVersion}`
    );
  }

  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );

  decipher.setAuthTag(
    Buffer.from(authTag, "base64")
  );

  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(ciphertext, "base64")
    ),
    decipher.final()
  ]);

  return plaintext.toString("utf8");
}

module.exports = {
  encryptToken,
  decryptToken
};
