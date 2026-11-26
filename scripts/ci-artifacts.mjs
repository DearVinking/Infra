import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const magic = Buffer.from("ASTXCI01");
const [command, input, output, ...extra] = process.argv.slice(2);

try {
  const passphrase = process.env.ENCRYPTION_PASSPHRASE;
  if (!passphrase || !input || !output || extra.length) {
    throw new Error("Invalid arguments");
  }
  const data = readFileSync(input);
  let result;
  if (command === "seal") {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const header = Buffer.concat([magic, salt, nonce]);
    const cipher = createCipheriv("aes-256-gcm", key(passphrase, salt), nonce);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    result = Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
  } else if (command === "open") {
    if (data.length < 52 || !data.subarray(0, 8).equals(magic)) {
      throw new Error("Invalid envelope");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(passphrase, data.subarray(8, 24)),
      data.subarray(24, 36),
    );
    decipher.setAAD(data.subarray(0, 36));
    decipher.setAuthTag(data.subarray(36, 52));
    result = Buffer.concat([
      decipher.update(data.subarray(52)),
      decipher.final(),
    ]);
  } else {
    throw new Error("Invalid command");
  }
  // 解密完成认证后才落盘，且不覆盖已有文件。
  writeFileSync(output, result, { flag: "wx", mode: 0o600 });
} catch {
  console.error("CI artifact operation failed.");
  process.exitCode = 1;
}

function key(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, {
    N: 131072,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
}
