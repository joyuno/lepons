import { test } from "node:test";
import assert from "node:assert/strict";

import { base32Decode, base32Encode, matchTotp, otpauthUri, totpAt, stepOf } from "./totp.ts";

// RFC 6238 appendix B, the SHA1 column: the ASCII key "12345678901234567890".
const rfcSecret = base32Encode(Buffer.from("12345678901234567890"));
const vectors: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("RFC 6238 SHA1 test vectors, eight digits", () => {
  for (const [seconds, code] of vectors) assert.equal(totpAt(rfcSecret, stepOf(seconds * 1000), 8), code, `T=${seconds}`);
});

test("six digits are the last six of the same truncation", () => {
  for (const [seconds, code] of vectors) assert.equal(totpAt(rfcSecret, stepOf(seconds * 1000)), code.slice(2));
});

test("base32 round-trips and decodes the RFC key", () => {
  assert.equal(rfcSecret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(rfcSecret).toString(), "12345678901234567890");
  assert.equal(base32Decode("gezd gnbv").toString(), "12345");
});

test("a code is accepted one step either side, and no further", () => {
  const now = 1111111111 * 1000;
  const step = stepOf(now);
  assert.equal(matchTotp(rfcSecret, totpAt(rfcSecret, step), now), step);
  assert.equal(matchTotp(rfcSecret, totpAt(rfcSecret, step - 1), now), step - 1);
  assert.equal(matchTotp(rfcSecret, totpAt(rfcSecret, step + 1), now), step + 1);
  assert.equal(matchTotp(rfcSecret, totpAt(rfcSecret, step - 2), now), undefined);
  assert.equal(matchTotp(rfcSecret, totpAt(rfcSecret, step + 2), now), undefined);
});

test("a wrong or malformed code matches nothing", () => {
  const now = 1234567890 * 1000;
  const right = totpAt(rfcSecret, stepOf(now));
  const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
  assert.equal(matchTotp(rfcSecret, wrong, now), undefined);
  assert.equal(matchTotp(rfcSecret, "", now), undefined);
  assert.equal(matchTotp(rfcSecret, "12345a", now), undefined);
  assert.equal(matchTotp(rfcSecret, `${right}0`, now), undefined);
});

test("the otpauth URI names the issuer and the secret", () => {
  assert.equal(
    otpauthUri("ABC", "이 PC"),
    "otpauth://totp/Lepons%3A%EC%9D%B4%20PC?secret=ABC&issuer=Lepons&algorithm=SHA1&digits=6&period=30",
  );
});
