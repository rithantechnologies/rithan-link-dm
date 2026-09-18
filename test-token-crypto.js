require("dotenv").config();

const {
  encryptToken,
  decryptToken
} = require("./lib/token-crypto");

const fakeToken =
  "THIS_IS_A_FAKE_INSTAGRAM_TOKEN_FOR_TESTING_ONLY";

const encrypted = encryptToken(fakeToken);

console.log("Encryption successful");
console.log({
  ciphertextPresent: Boolean(encrypted.ciphertext),
  ivPresent: Boolean(encrypted.iv),
  authTagPresent: Boolean(encrypted.authTag),
  keyVersion: encrypted.keyVersion
});

const decrypted = decryptToken(encrypted);

console.log(
  "Decryption matches:",
  decrypted === fakeToken
);

if (decrypted !== fakeToken) {
  process.exitCode = 1;
}
