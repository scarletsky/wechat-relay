// SPDX-License-Identifier: AGPL-3.0-or-later

export function testConfig(overrides = {}) {
  const config = {
    appId: "test-app-id",
    appSecret: "test-app-secret",
    relayToken: "r".repeat(48),
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    maxJsonBodyBytes: 4 * 1024 * 1024,
    maxMediaBodyBytes: 20 * 1024 * 1024,
    maxUpstreamResponseBytes: 2 * 1024 * 1024,
    bodyTimeoutMs: 1_000,
    upstreamTimeoutMs: 1_000,
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 100,
    healthRateLimitMaxRequests: 100,
    preauthRateLimitMaxRequests: 100,
    maxConcurrentUpstream: 4,
    maxConnections: 64,
    idempotencyMaxRecords: 10_000,
    idempotencyFailedSafeRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    ...overrides,
  };
  return {
    accounts: [{
      name: "default",
      appId: config.appId,
      appSecret: config.appSecret,
      relayToken: config.relayToken,
    }],
    ...config,
  };
}

export function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function authHeaders(config, extra = {}, relayToken = config.relayToken) {
  return {
    Authorization: `Bearer ${relayToken}`,
    ...extra,
  };
}
