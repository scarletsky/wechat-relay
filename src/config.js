// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { ConfigurationError } from "./errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const LEGACY_CREDENTIAL_NAMES = ["WECHAT_APP_ID", "WECHAT_APP_SECRET", "RELAY_TOKEN"];
const ACCOUNT_FIELDS = new Set(["name", "appId", "appSecret", "relayToken"]);
const ACCOUNT_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/u;
const MAX_ACCOUNTS_FILE_BYTES = 64 * 1024;
// The single account built from the legacy environment variables. Its
// idempotency keys are stored without an account prefix, so naming a migrated
// account "default" keeps replay protection for existing records.
export const LEGACY_ACCOUNT_NAME = "default";
// Supported Node.js major -> minimum minor release. better-sqlite3 13 requires
// Node-API 10, which Node.js 22 provides only from 22.14.0.
const SUPPORTED_NODE_MINIMUM_MINORS = new Map([
  [22, 14],
  [24, 0],
]);

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const minimumMinor = SUPPORTED_NODE_MINIMUM_MINORS.get(major);
  if (minimumMinor === undefined || !(minor >= minimumMinor)) {
    throw new ConfigurationError(
      "unsupported_NODE_VERSION",
      "Node.js version must be 22.14.0 or a later 22.x release, or 24.x.",
    );
  }
}

function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) {
    throw new ConfigurationError(`missing_${name}`, `${name} is required.`);
  }
  return value;
}

function boundedInteger(env, name, fallback, minimum, maximum) {
  const raw = String(env[name] ?? "").trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `invalid_${name}`,
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function validateRelayToken(token, label = "RELAY_TOKEN") {
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(token)) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN",
      `${label} must use visible ASCII base64, base64url, hex, or equivalent token characters.`,
    );
  }
  const byteLength = Buffer.byteLength(token, "utf8");
  const minimumEncodedLength = /^[0-9a-f]+$/iu.test(token) ? 64 : 43;
  if (byteLength < minimumEncodedLength || byteLength > 512) {
    throw new ConfigurationError(
      "invalid_RELAY_TOKEN_length",
      `${label} must encode at least 32 random bytes (43 base64/base64url characters or 64 hex characters) and be at most 512 characters.`,
    );
  }
}

function legacyAccount(env) {
  const appId = required(env, "WECHAT_APP_ID");
  const appSecret = required(env, "WECHAT_APP_SECRET");
  const relayToken = required(env, "RELAY_TOKEN");
  validateRelayToken(relayToken);
  return Object.freeze({ name: LEGACY_ACCOUNT_NAME, appId, appSecret, relayToken });
}

function readAccountsFile(filename) {
  let raw;
  try {
    raw = fs.readFileSync(filename);
  } catch {
    throw new ConfigurationError(
      "unreadable_WECHAT_ACCOUNTS_FILE",
      "WECHAT_ACCOUNTS_FILE could not be read.",
    );
  }
  if (raw.length > MAX_ACCOUNTS_FILE_BYTES) {
    throw new ConfigurationError(
      "invalid_WECHAT_ACCOUNTS_FILE_size",
      `WECHAT_ACCOUNTS_FILE must be at most ${MAX_ACCOUNTS_FILE_BYTES} bytes.`,
    );
  }
  try {
    // Never echo parser messages: they may quote fragments of a secret.
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ConfigurationError(
      "invalid_WECHAT_ACCOUNTS_FILE",
      "WECHAT_ACCOUNTS_FILE must contain valid JSON.",
    );
  }
}

function parseAccounts(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError(
      "invalid_WECHAT_ACCOUNTS_FILE",
      "WECHAT_ACCOUNTS_FILE must contain a non-empty JSON array of accounts.",
    );
  }
  const seen = { name: new Set(), appId: new Set(), relayToken: new Set() };
  return value.map((entry, index) => {
    const label = `Account #${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ConfigurationError("invalid_account", `${label} must be a JSON object.`);
    }
    for (const key of Object.keys(entry)) {
      if (!ACCOUNT_FIELDS.has(key)) {
        throw new ConfigurationError("unknown_account_field", `${label} has an unsupported field.`);
      }
    }
    const account = {};
    for (const field of ACCOUNT_FIELDS) {
      const fieldValue = entry[field];
      if (typeof fieldValue !== "string" || !fieldValue) {
        throw new ConfigurationError(`missing_account_${field}`, `${label} requires a non-empty ${field}.`);
      }
      account[field] = fieldValue;
    }
    if (!ACCOUNT_NAME_PATTERN.test(account.name)) {
      throw new ConfigurationError(
        "invalid_account_name",
        `${label} name must be 1-32 lowercase letters, digits, underscores, or hyphens.`,
      );
    }
    validateRelayToken(account.relayToken, `${label} relayToken`);
    for (const field of Object.keys(seen)) {
      if (seen[field].has(account[field])) {
        throw new ConfigurationError(`duplicate_account_${field}`, `${label} repeats another account's ${field}.`);
      }
      seen[field].add(account[field]);
    }
    return Object.freeze(account);
  });
}

function loadAccounts(env) {
  const accountsFile = String(env.WECHAT_ACCOUNTS_FILE ?? "").trim();
  if (!accountsFile) return [legacyAccount(env)];
  if (LEGACY_CREDENTIAL_NAMES.some((name) => String(env[name] ?? "").trim())) {
    throw new ConfigurationError(
      "ambiguous_account_config",
      "Set either WECHAT_ACCOUNTS_FILE or WECHAT_APP_ID/WECHAT_APP_SECRET/RELAY_TOKEN, not both.",
    );
  }
  return parseAccounts(readAccountsFile(accountsFile));
}

export function loadConfig(env = process.env) {
  assertSupportedNodeVersion();
  const accounts = Object.freeze(loadAccounts(env));

  const host = String(env.HOST ?? "").trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigurationError(
      "non_loopback_HOST",
      "HOST must be 127.0.0.1 or ::1. Put a private or TLS reverse proxy in front.",
    );
  }

  const dbPathValue = String(env.DB_PATH ?? "").trim() || "./data/idempotency.sqlite3";
  if (dbPathValue.includes("\u0000")) {
    throw new ConfigurationError("invalid_DB_PATH", "DB_PATH contains a null byte.");
  }

  return Object.freeze({
    accounts,
    host,
    port: boundedInteger(env, "PORT", 18_794, 1_024, 65_535),
    dbPath: dbPathValue === ":memory:" ? dbPathValue : path.resolve(dbPathValue),
    maxJsonBodyBytes: boundedInteger(env, "MAX_JSON_BODY_BYTES", 4 * 1024 * 1024, 1_024, 8 * 1024 * 1024),
    maxMediaBodyBytes: boundedInteger(env, "MAX_MEDIA_BODY_BYTES", 20 * 1024 * 1024, 1_024, 32 * 1024 * 1024),
    maxUpstreamResponseBytes: boundedInteger(
      env,
      "MAX_UPSTREAM_RESPONSE_BYTES",
      2 * 1024 * 1024,
      1_024,
      8 * 1024 * 1024,
    ),
    bodyTimeoutMs: boundedInteger(env, "BODY_TIMEOUT_MS", 15_000, 1_000, 60_000),
    upstreamTimeoutMs: boundedInteger(env, "UPSTREAM_TIMEOUT_MS", 25_000, 1_000, 120_000),
    rateLimitWindowMs: boundedInteger(env, "RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    rateLimitMaxRequests: boundedInteger(env, "RATE_LIMIT_MAX_REQUESTS", 60, 1, 10_000),
    healthRateLimitMaxRequests: boundedInteger(
      env,
      "HEALTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    preauthRateLimitMaxRequests: boundedInteger(
      env,
      "PREAUTH_RATE_LIMIT_MAX_REQUESTS",
      120,
      1,
      10_000,
    ),
    maxConcurrentUpstream: boundedInteger(env, "MAX_CONCURRENT_UPSTREAM", 4, 1, 32),
    maxConnections: boundedInteger(env, "MAX_CONNECTIONS", 64, 4, 512),
    idempotencyMaxRecords: boundedInteger(
      env,
      "IDEMPOTENCY_MAX_RECORDS",
      10_000,
      100,
      100_000,
    ),
    idempotencyFailedSafeRetentionMs: boundedInteger(
      env,
      "IDEMPOTENCY_FAILED_SAFE_RETENTION_MS",
      7 * 24 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
    ),
  });
}

export function isLoopbackAddress(address) {
  const normalized = String(address ?? "").toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}
