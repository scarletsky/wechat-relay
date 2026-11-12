// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthenticator } from "../src/auth.js";
import { assertNoBody } from "../src/body.js";
import { assertSupportedNodeVersion, isLoopbackAddress, loadConfig } from "../src/config.js";
import { resolveRoute } from "../src/routes.js";

function validEnv() {
  return {
    WECHAT_APP_ID: "test-app-id",
    WECHAT_APP_SECRET: "test-app-secret",
    RELAY_TOKEN: "r".repeat(48),
    DB_PATH: ":memory:",
  };
}

test("startup fails closed when any required credential is missing", () => {
  for (const name of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"]) {
    const env = validEnv();
    delete env[name];
    assert.throws(() => loadConfig(env), { code: `missing_${name}` });
  }
});

test("executable exits before listening when credentials are absent", () => {
  const result = spawnSync(process.execPath, ["src/index.js"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /"event":"startup\.failed"/u);
  assert.match(result.stderr, /"code":"missing_WECHAT_APP_ID"/u);
});

function writeAccountsFile(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-relay-accounts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "accounts.json");
  fs.writeFileSync(filename, typeof content === "string" ? content : JSON.stringify(content));
  return filename;
}

function validAccounts() {
  return [
    { name: "main", appId: "main-app-id", appSecret: "main-app-secret", relayToken: "m".repeat(48) },
    { name: "blog", appId: "blog-app-id", appSecret: "blog-app-secret", relayToken: "q".repeat(48) },
  ];
}

test("legacy environment credentials become the default account", () => {
  assert.deepEqual(loadConfig(validEnv()).accounts, [{
    name: "default",
    appId: "test-app-id",
    appSecret: "test-app-secret",
    relayToken: "r".repeat(48),
  }]);
});

test("accounts file supplies several accounts", (t) => {
  const filename = writeAccountsFile(t, validAccounts());
  const config = loadConfig({ WECHAT_ACCOUNTS_FILE: filename, DB_PATH: ":memory:" });
  assert.deepEqual(config.accounts, validAccounts());
  assert.equal(Object.isFrozen(config.accounts[0]), true);
});

test("accounts file and legacy credentials are mutually exclusive", (t) => {
  const filename = writeAccountsFile(t, validAccounts());
  for (const name of ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"]) {
    assert.throws(
      () => loadConfig({ WECHAT_ACCOUNTS_FILE: filename, [name]: validEnv()[name] }),
      { code: "ambiguous_account_config" },
      name,
    );
  }
});

test("accounts file fails closed without echoing its contents", (t) => {
  const secret = "s".repeat(48);
  const load = (content) => loadConfig({ WECHAT_ACCOUNTS_FILE: writeAccountsFile(t, content) });
  const cases = [
    [`[{"name":"main","appSecret":"${secret}"`, "invalid_WECHAT_ACCOUNTS_FILE"],
    [{}, "invalid_WECHAT_ACCOUNTS_FILE"],
    [[], "invalid_WECHAT_ACCOUNTS_FILE"],
    [["main"], "invalid_account"],
    [[{ ...validAccounts()[0], appSecert: secret }], "unknown_account_field"],
    [[{ ...validAccounts()[0], appSecret: "" }], "missing_account_appSecret"],
    [[{ ...validAccounts()[0], appId: 1 }], "missing_account_appId"],
    [[{ ...validAccounts()[0], name: "Main" }], "invalid_account_name"],
    [[{ ...validAccounts()[0], name: "a".repeat(33) }], "invalid_account_name"],
    [[{ ...validAccounts()[0], relayToken: "x".repeat(42) }], "invalid_RELAY_TOKEN_length"],
    [[validAccounts()[0], { ...validAccounts()[1], name: "main" }], "duplicate_account_name"],
    [[validAccounts()[0], { ...validAccounts()[1], appId: "main-app-id" }], "duplicate_account_appId"],
    [
      [validAccounts()[0], { ...validAccounts()[1], relayToken: "m".repeat(48) }],
      "duplicate_account_relayToken",
    ],
    [" ".repeat(64 * 1024 + 1), "invalid_WECHAT_ACCOUNTS_FILE_size"],
  ];
  for (const [content, code] of cases) {
    assert.throws(
      () => load(content),
      (error) => error.code === code && !error.message.includes(secret),
      code,
    );
  }
  assert.throws(
    () => loadConfig({ WECHAT_ACCOUNTS_FILE: path.join(os.tmpdir(), "wechat-relay-missing", "accounts.json") }),
    { code: "unreadable_WECHAT_ACCOUNTS_FILE" },
  );
});

test("relay token must encode at least 32 random bytes", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "x".repeat(31) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "z".repeat(42) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.equal(loadConfig({ ...validEnv(), RELAY_TOKEN: "z".repeat(43) }).accounts[0].relayToken.length, 43);
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "a".repeat(63) }),
    { code: "invalid_RELAY_TOKEN_length" },
  );
  assert.equal(loadConfig({ ...validEnv(), RELAY_TOKEN: "a".repeat(64) }).accounts[0].relayToken.length, 64);
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: "密".repeat(32) }),
    { code: "invalid_RELAY_TOKEN" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), RELAY_TOKEN: `${"x".repeat(32)} internal-space` }),
    { code: "invalid_RELAY_TOKEN" },
  );
});

test("configuration rejects non-loopback binding", () => {
  assert.throws(
    () => loadConfig({ ...validEnv(), HOST: "0.0.0.0" }),
    { code: "non_loopback_HOST" },
  );
  assert.equal(loadConfig({ ...validEnv(), HOST: "::1" }).host, "::1");
});

test("runtime accepts only Node 22.14+, 24.x, and 26.x", () => {
  for (const version of ["22.14.0", "22.22.0", "24.0.0", "24.14.1", "26.0.0", "26.13.1"]) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version), version);
  }
  for (const version of [
    "19.9.0",
    "20.20.2",
    "21.7.3",
    "22.0.0",
    "22.13.1",
    "23.11.1",
    "25.0.0",
    "27.0.0",
    "22",
    "invalid",
  ]) {
    assert.throws(
      () => assertSupportedNodeVersion(version),
      { code: "unsupported_NODE_VERSION" },
      version,
    );
  }
});

test("idempotency capacity and failed-safe retention are bounded", () => {
  const defaults = loadConfig(validEnv());
  assert.equal(defaults.idempotencyMaxRecords, 10_000);
  assert.equal(defaults.idempotencyFailedSafeRetentionMs, 7 * 24 * 60 * 60 * 1_000);
  assert.throws(
    () => loadConfig({ ...validEnv(), IDEMPOTENCY_MAX_RECORDS: "99" }),
    { code: "invalid_IDEMPOTENCY_MAX_RECORDS" },
  );
  assert.throws(
    () => loadConfig({ ...validEnv(), IDEMPOTENCY_FAILED_SAFE_RETENTION_MS: "59999" }),
    { code: "invalid_IDEMPOTENCY_FAILED_SAFE_RETENTION_MS" },
  );
});

test("loopback peer recognition is narrow", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.0.2.10"), false);
});

test("route matching rejects non-canonical paths and query spellings", () => {
  assert.throws(
    () => resolveRoute("/wechat/ignored/../draft/get", "POST"),
    { statusCode: 400, code: "invalid_request_target" },
  );
  assert.throws(
    () => resolveRoute("/wechat/material/add_material?type=image&", "POST"),
    { statusCode: 400, code: "invalid_material_type" },
  );
  assert.throws(
    () => resolveRoute("/v1/health?", "GET"),
    { statusCode: 400, code: "unexpected_query" },
  );
  assert.throws(
    () => resolveRoute("/wechat/material/add_material?", "POST"),
    { statusCode: 400, code: "invalid_material_type" },
  );
  assert.equal(resolveRoute("/wechat/material/add_material?type=image", "POST").query.type, "image");
});

test("status endpoints reject declared or streamed request bodies", () => {
  assert.doesNotThrow(() => assertNoBody({ headers: { "content-length": "0" } }));
  assert.throws(
    () => assertNoBody({ headers: { "content-length": "1" } }),
    { statusCode: 400, code: "unexpected_body" },
  );
  assert.throws(
    () => assertNoBody({ headers: { "transfer-encoding": "chunked" } }),
    { statusCode: 400, code: "unexpected_body" },
  );
});

test("authentication accepts exactly one correct credential header", () => {
  const token = "a".repeat(48);
  const authenticate = createAuthenticator([{ name: "default", relayToken: token }]);
  assert.doesNotThrow(() => authenticate({ headers: { authorization: `Bearer ${token}` } }));
  assert.doesNotThrow(() => authenticate({ headers: { "x-relay-token": token } }));
  assert.throws(() => authenticate({ headers: { authorization: "Bearer wrong" } }), { statusCode: 401 });
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}`, "x-relay-token": token },
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
  for (const headers of [
    { authorization: "", "x-relay-token": token },
    { authorization: `Bearer ${token}`, "x-relay-token": "" },
  ]) {
    assert.throws(
      () => authenticate({ headers }),
      { statusCode: 400, code: "ambiguous_authentication" },
    );
  }
  assert.throws(
    () => authenticate({
      headers: { authorization: `Bearer ${token}` },
      rawHeaders: ["Authorization", `Bearer ${token}`, "Authorization", "Bearer other"],
    }),
    { statusCode: 400, code: "ambiguous_authentication" },
  );
});

test("authentication returns the account that owns the token", () => {
  const accounts = validAccounts();
  const authenticate = createAuthenticator(accounts);
  assert.equal(authenticate({ headers: { authorization: `Bearer ${"m".repeat(48)}` } }), accounts[0]);
  assert.equal(authenticate({ headers: { "x-relay-token": "q".repeat(48) } }), accounts[1]);
  assert.throws(
    () => authenticate({ headers: { authorization: `Bearer ${"r".repeat(48)}` } }),
    { statusCode: 401, code: "unauthorized" },
  );
});
