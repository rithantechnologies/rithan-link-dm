const crypto = require("crypto");
const { promisify } = require("util");

const scryptAsync =
  promisify(crypto.scrypt);

const N = 16384;
const r = 8;
const p = 1;

const KEY_LENGTH = 64;

async function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 12
  ) {
    throw new Error(
      "Password must be at least 12 characters"
    );
  }

  const salt =
    crypto.randomBytes(16);

  const derivedKey =
    await scryptAsync(
      password,
      salt,
      KEY_LENGTH,
      {
        N,
        r,
        p,
        maxmem: 64 * 1024 * 1024
      }
    );

  return [
    "scrypt",
    N,
    r,
    p,
    salt.toString("hex"),
    derivedKey.toString("hex")
  ].join("$");
}

async function verifyPassword(
  password,
  storedHash
) {
  try {
    const [
      algorithm,
      nValue,
      rValue,
      pValue,
      saltHex,
      hashHex
    ] = String(storedHash).split("$");

    if (algorithm !== "scrypt") {
      return false;
    }

    const expected =
      Buffer.from(
        hashHex,
        "hex"
      );

    const actual =
      await scryptAsync(
        password,
        Buffer.from(
          saltHex,
          "hex"
        ),
        expected.length,
        {
          N: Number(nValue),
          r: Number(rValue),
          p: Number(pValue),
          maxmem: 64 * 1024 * 1024
        }
      );

    return (
      actual.length === expected.length &&
      crypto.timingSafeEqual(
        actual,
        expected
      )
    );

  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword
};
