import { test } from "node:test";
import assert from "node:assert/strict";

import { maskForEgress, isSensitivePath } from "./mask.ts";

const salt = "repo-salt-a";
const otherSalt = "repo-salt-b";
const mask = (path: string, text: string, useSalt = salt) =>
  maskForEgress(path, Buffer.from(text, "utf8"), useSalt);

test("a .env keeps key names and hides values", () => {
  const result = mask(".env", "DATABASE_URL=postgres://user:hunter2@db/app\nAPI_KEY=sk-abc123\n");

  const text = result.content.toString("utf8");
  assert.equal(result.masked, true);
  assert.match(text, /^DATABASE_URL=/m);
  assert.match(text, /^API_KEY=/m);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /sk-abc123/);
});

// Deterministic so a reader can tell whether a value changed; salted so the
// placeholder is not an offline oracle for guessing low-entropy values.
test("placeholders are stable per repository and differ across repositories", () => {
  const first = mask(".env", "TOKEN=same-value\n").content.toString("utf8");
  const again = mask(".env", "TOKEN=same-value\n").content.toString("utf8");
  const elsewhere = mask(".env", "TOKEN=same-value\n", otherSalt).content.toString("utf8");

  assert.equal(first, again);
  assert.notEqual(first, elsewhere);
});

test("a changed value produces a different placeholder", () => {
  const before = mask(".env", "TOKEN=one\n").content.toString("utf8");
  const after = mask(".env", "TOKEN=two\n").content.toString("utf8");
  assert.notEqual(before, after);
});

test("comments, blank lines, and the export form survive", () => {
  const text = mask(
    ".env",
    "# database\n\nexport DATABASE_URL=postgres://u:p@h/d\nPLAIN=value\n",
  ).content.toString("utf8");

  assert.match(text, /^# database$/m);
  assert.match(text, /^$/m);
  assert.match(text, /^export DATABASE_URL=/m);
  assert.doesNotMatch(text, /postgres:\/\/u:p@h/);
});

test("quoted values are hidden including the quotes' contents", () => {
  const text = mask(".env", 'SECRET="quoted secret"\nOTHER=\'single\'\n').content.toString("utf8");
  assert.doesNotMatch(text, /quoted secret/);
  assert.doesNotMatch(text, /single/);
});

test("path patterns from the spec are treated as sensitive", () => {
  for (const path of [
    ".env",
    ".env.local",
    "config/.env.production",
    "certs/server.pem",
    "keys/id_rsa",
    "keys/id_ed25519",
    "credentials.json",
    "infra/prod.tfvars",
    "app.local.json",
  ]) {
    assert.equal(isSensitivePath(path), true, `${path} should be sensitive`);
  }
  for (const path of ["src/main.ts", "README.md", "environment.md", "identity.go"]) {
    assert.equal(isSensitivePath(path), false, `${path} should not be sensitive`);
  }
});

// The single egress gate has to catch secrets in ordinary files too, because
// path classification only sees the ones that were named conventionally.
test("a token inside an ordinary source file is hidden, the rest is not", () => {
  const result = mask(
    "src/config.ts",
    'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\nexport const port = 8080;\n',
  );

  const text = result.content.toString("utf8");
  assert.equal(result.masked, true);
  assert.doesNotMatch(text, /sk-ant-api03-abcdefghijklmnopqrstuvwxyz/);
  assert.match(text, /export const port = 8080;/);
});

test("the content detectors from the spec fire", () => {
  const samples: Array<{ path: string; text: string; secret: string }> = [
    { path: "src/a.ts", text: "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", secret: "ghp_0123456789abcdef" },
    { path: "src/b.ts", text: "AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
    // Split so secret scanners do not take this dummy for a real Slack token.
    { path: "src/c.ts", text: "xox" + "b-123456789012-abcdefghijklmnop", secret: "xox" + "b-123456789012" },
    { path: "src/d.ts", text: "glpat-abcdefghijklmnopqrst", secret: "glpat-abcdefghijklmnopqrst" },
    { path: "src/e.ts", text: "db=postgres://admin:s3cr3tpw@host:5432/app", secret: "s3cr3tpw" },
  ];
  for (const { path, text, secret } of samples) {
    const masked = mask(path, text).content.toString("utf8");
    const literal = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.doesNotMatch(masked, literal, path);
  }
});

test("a PEM block is hidden without losing that it was a key", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabc123secretmaterial\n-----END RSA PRIVATE KEY-----\n";
  const text = mask("src/embedded.ts", pem).content.toString("utf8");

  assert.doesNotMatch(text, /abc123secretmaterial/);
  assert.match(text, /BEGIN RSA PRIVATE KEY/);
});

test("an ordinary file with no secrets is returned untouched", () => {
  const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
  const result = mask("src/add.ts", source);

  assert.equal(result.masked, false);
  assert.equal(result.content.toString("utf8"), source);
});

// Binary content must not be corrupted by a text-oriented scan, and must not
// silently pass either.
test("binary content is refused rather than scanned", () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]);
  const result = maskForEgress("assets/logo.png", binary, salt);
  assert.equal(result.masked, true);
  assert.equal(result.binary, true);
  assert.equal(result.content.length, 0);
});

// "Codex 데이터" is offered for sharing, and ~/.codex/auth.json holds a
// refresh token shaped "rt.…" that no prefix detector knows -- it left the
// machine in full. Any credential-named JSON key now hides its value.
test("a login file's tokens are hidden whatever their shape", () => {
  const auth = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "plain-api-key-value-123",
    tokens: { refresh_token: "rt.ABCdef0123456789-_xyzXYZ.more", account_id: "5b9a-acc" },
    client_secret: "s3cretvalue!",
  }, null, 2);
  const text = mask("auth.json", auth).content.toString("utf8");
  for (const secret of ["rt.ABCdef0123456789", "plain-api-key-value-123", "s3cretvalue!"]) assert.doesNotMatch(text, new RegExp(secret.replace(/[.!]/g, "\$&")));
  // Not every key is a secret, and a short placeholder-like value is left alone.
  assert.match(text, /"auth_mode": "chatgpt"/);
  assert.match(text, /"account_id": "5b9a-acc"/);
  assert.equal(mask("package.json", '{"max_tokens": 4096, "tokenizer": "cl100k_base_x", "token": "string"}').masked, false);
});

test("credential keys are caught in any spelling, with any value, and in config files", () => {
  const json = String.raw`{"refresh-token": "rt.abc def\"ghi-123", "x-api-key": "k_0123456789", "client.secret": "s3cr3t-value"}`;
  const text = mask("auth.json", json).content.toString("utf8");
  for (const secret of ["abc def", "ghi-123", "k_0123456789", "s3cr3t-value"]) assert.ok(!text.includes(secret), secret);

  const yaml = "server:\n  token: abc\n  api-key: 'quoted value'\n  tokenizer: cl100k\n  max_tokens: 4096\n";
  const y = mask("config.yml", yaml).content.toString("utf8");
  assert.ok(!y.includes("abc") && !y.includes("quoted value"));
  assert.match(y, /tokenizer: cl100k/);
  assert.match(y, /max_tokens: 4096/);

  const toml = '[mcp_servers.x]\nexperimental_bearer_token = "x"\nmodel = "gpt-5"\n';
  const t = mask(".codex/config.toml", toml).content.toString("utf8");
  assert.doesNotMatch(t, /= "x"/);
  assert.match(t, /experimental_bearer_token = "\*\*\*[0-9a-f]{8}"/);
  assert.match(t, /model = "gpt-5"/);
});
