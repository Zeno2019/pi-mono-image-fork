import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Any undeclared network work, including install telemetry, must fail this suite.
const unexpectedRequests = [];
const originalFetch = globalThis.fetch;
const agentDir = await mkdtemp(join(tmpdir(), "host-no-telemetry-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_TELEMETRY = "1";
delete process.env.CI;
globalThis.fetch = async (url) => {
  unexpectedRequests.push(String(url));
  throw new Error("undeclared-network-request");
};
const { createHostedImageGenerator, imageAuthProvider } = await import("../.test-dist/extensions/host.js");
after(async () => {
  globalThis.fetch = originalFetch;
  const entries = await readdir(agentDir);
  await rm(agentDir, { recursive: true, force: true });
  assert.deepEqual(entries, []);
  assert.deepEqual(unexpectedRequests, []);
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
function response(image = PNG.toString("base64")) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id: "response_fixture", status: "completed", output: [{ type: "image_generation_call", id: "image_fixture", status: "completed", result: image }],
  } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function fixture(overrides = {}, registryOverride) {
  const events = [];
  const providers = [];
  const registry = registryOverride ?? {
    async getProviderAuth(provider) {
      providers.push(provider);
      return { source: "OAuth", auth: { apiKey: token } };
    },
    getApiKeyForProvider() { throw new Error("legacy-must-not-be-read"); },
  };
  const generate = createHostedImageGenerator({
    model: "gpt-6-astra",
    async prepare(toolCallId, branchId) {
      events.push("prepare");
      assert.equal(toolCallId, "tool"); assert.equal(branchId, "branch");
      return { operationId: "operation", referenceImages: [{ bytes: PNG, mimeType: "image/png" }] };
    },
    async beforeRequest(input) { events.push("before-request"); assert.deepEqual(input, { operationId: "operation", toolCallId: "tool" }); },
    async fetch(url, init) {
      events.push("http");
      assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.headers["chatgpt-account-id"], "fixture-account");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.equal(body.prompt_cache_key, "operation"); assert.equal(body.store, false);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.input[0].content[1], { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` });
      return response();
    },
    async persist(input) { events.push("persist"); assert.deepEqual(input.bytes, PNG); return { recordId: "generic-record" }; },
    ...overrides,
  });
  return { events, providers, run: (params = { prompt: "fixture" }, signal) => generate("tool", params, "branch", registry, signal) };
}

test("generic host uses owned OAuth, controlled bytes, and arbitrary persistence results without telemetry", async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(f.events, ["prepare", "before-request", "http", "persist"]);
  assert.deepEqual(f.providers, ["codex-images"]);
  assert.equal(imageAuthProvider.id, "codex-images");
  assert.equal(result.operationId, "operation"); assert.equal(result.responseId, "response_fixture");
  assert.equal(result.imageGenerationId, "image_fixture");
  assert.deepEqual(result.bytes, PNG); assert.equal(result.data, PNG.toString("base64"));
  assert.deepEqual(result.persisted, { recordId: "generic-record" });
  assert.equal(result.mimeType, "image/png");
});

test("strict authentication rejects missing, API-key, failed, and legacy-only credentials without fallback", async () => {
  for (const value of [undefined, { source: "API key", auth: { apiKey: "private-api-key" } }, { source: "OAuth", auth: {} }, "throw"]) {
    const providers = [];
    const f = fixture({}, {
      async getProviderAuth(provider) {
        providers.push(provider);
        assert.equal(provider, "codex-images");
        if (value === "throw") throw new Error("private-auth-error");
        return value;
      },
      getApiKeyForProvider() { assert.fail("legacy API must never be read"); },
    });
    await assert.rejects(f.run(), error => /authentication failed/i.test(error.message) && !/private/.test(error.message));
    assert.deepEqual(providers, ["codex-images"]); assert.deepEqual(f.events, ["prepare"]);
  }
  const legacy = fixture({}, { getApiKeyForProvider() { assert.fail("legacy-only registry must be rejected"); } });
  await assert.rejects(legacy.run(), /authentication failed/i);
  assert.deepEqual(legacy.events, ["prepare"]);
});

test("path selectors, extra keys, invalid prompts, and invalid formats have no host effects", async () => {
  for (const params of [null, [], { prompt: " " }, { prompt: "x".repeat(32001) }, { prompt: "x", outputFormat: "gif" },
    ...["saveDir", "referencedImagePaths", "numLastImagesToInclude", "model", "url"].map(key => ({ prompt: "x", [key]: "untrusted" }))]) {
    const f = fixture();
    await assert.rejects(f.run(params)); assert.deepEqual(f.events, []);
  }
});

test("host reference validation enforces count, individual/total byte budgets, and signatures before auth", async () => {
  const image = { bytes: PNG, mimeType: "image/png" };
  const large = { bytes: Buffer.concat([PNG, Buffer.alloc(18 * 1024 * 1024)]), mimeType: "image/png" };
  for (const referenceImages of [null, Array(6).fill(image), [{ ...image, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }],
    Array(3).fill(large), [{ ...image, mimeType: "image/jpeg" }], [{ ...image, bytes: new Uint8Array([1, 2]) }], [{ ...image, bytes: "path" }]]) {
    const f = fixture({ async prepare() { return { operationId: "operation", referenceImages }; } });
    await assert.rejects(f.run()); assert.deepEqual(f.providers, []); assert.deepEqual(f.events, []);
  }
});

test("429 and 503 each issue exactly one image request and never persist", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const f = fixture({ async fetch() { calls += 1; return new Response("private-http-error", { status, headers: { "retry-after": "0" } }); } });
    await assert.rejects(f.run(), /No automatic retry was made/);
    assert.equal(calls, 1); assert.deepEqual(f.events, ["prepare", "before-request"]);
  }
});

test("host authorization and pre-request cancellation prevent image HTTP", async () => {
  const f = fixture({ async beforeRequest() { throw new Error("private-host-error"); } });
  await assert.rejects(f.run(), /No image request was made/); assert.deepEqual(f.events, ["prepare"]);
  const controller = new AbortController();
  const cancelled = fixture({ async beforeRequest() { controller.abort(); } });
  await assert.rejects(cancelled.run(undefined, controller.signal)); assert.deepEqual(cancelled.events, ["prepare"]);
});

test("completed images finish persistence even when cancellation arrives during storage", async () => {
  const controller = new AbortController();
  let saved = false;
  const f = fixture({ async persist(...args) {
    assert.equal(args.length, 1); assert.deepEqual(args[0].bytes, PNG);
    controller.abort(); await new Promise(resolve => setImmediate(resolve));
    saved = true; return "host-receipt";
  } });
  const result = await f.run(undefined, controller.signal);
  assert.equal(saved, true); assert.equal(result.persisted, "host-receipt");
  assert.deepEqual(f.events, ["prepare", "before-request", "http"]);
});

test("bad image responses and storage failures do not cause another request or leak payloads", async () => {
  const bad = fixture({ async fetch() { return response("SECRET!!!!"); } });
  await assert.rejects(bad.run(), error => !error.message.includes("SECRET"));
  assert.deepEqual(bad.events, ["prepare", "before-request"]);
  const failed = fixture({ async persist() { throw new Error("private-path"); } });
  await assert.rejects(failed.run(), /durable storage failed.*No automatic retry/);
  assert.deepEqual(failed.events, ["prepare", "before-request", "http"]);
});
