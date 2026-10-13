import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OutputLogs } from "../src/output-log.ts";
import { ProcessRuntime } from "../src/runtime.ts";

test("private logs enforce both quotas, reject paths/cursors, and clean only their own temporary directory", t => {
  const logs = new OutputLogs(8, 10);
  t.after(() => logs.close());
  const a = randomUUID(), b = randomUUID();
  logs.create(a); logs.create(b);
  assert.equal(statSync(logs.directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(logs.directory, a)).mode & 0o777, 0o600);
  logs.append(a, Buffer.from("0123456789"));
  logs.append(b, Buffer.from("abcdef"));
  assert.deepEqual(logs.read(a, 0, 4), { output: "0123", next_cursor: 4, unread_bytes: 4, dropped_bytes: 2 });
  assert.equal(logs.read(a, 0, 4).output, "0123", "readers do not consume each other's output");
  assert.equal(logs.read(b, 0, 8).output, "ab");
  assert.equal(logs.read(b, 0, 8).dropped_bytes, 4);
  assert.throws(() => logs.create("../outside"), /Invalid/);
  assert.throws(() => logs.read(a, -1, 4), /cursor/);
  assert.throws(() => logs.read(a, 1000, 4), /cursor/);
  logs.remove(a);
  assert.equal(existsSync(join(logs.directory, a)), false);
  logs.close(); logs.close();
  assert.equal(existsSync(logs.directory), false);
});

test("log cursors preserve UTF-8 boundaries", t => {
  const logs = new OutputLogs();
  t.after(() => logs.close());
  const id = randomUUID();
  logs.create(id);
  logs.append(id, Buffer.from("界界end"));
  const a = logs.read(id, 0, 4);
  assert.equal(a.output, "界");
  assert.equal(a.next_cursor, 3);
  assert.equal(logs.read(id, a.next_cursor, 4).output, "界e");
  const split = randomUUID();
  logs.create(split);
  const bytes = Buffer.from("界");
  logs.append(split, bytes.subarray(0, 2));
  assert.equal(logs.read(split, 0, 4).next_cursor, 0, "a partial UTF-8 scalar is not consumed");
  logs.append(split, bytes.subarray(2));
  assert.equal(logs.read(split, 0, 4).output, "界");
});

test("one multi-process wait returns early for any, all, and cancellation without consuming output", async t => {
  const rt = new ProcessRuntime();
  t.after(() => rt.close());
  const a = await rt.start("sleep 0.1; printf first", process.cwd(), false, 5000, false, 0, 1024);
  const b = await rt.start("sleep 0.4; printf second", process.cwd(), false, 5000, false, 0, 1024);
  await rt.wait([a.session_id, b.session_id], false, 5000);
  assert.equal(rt.output(a.session_id, 0, 1024).status, "exited");
  assert.equal(rt.output(b.session_id, 0, 1024).status, "running");
  await rt.wait([a.session_id, b.session_id], true, 5000);
  assert.equal(rt.output(b.session_id, 0, 1024).output, "second");
  assert.equal((await rt.poll(b.session_id, 0, 1024)).output, "second");
  const c = await rt.start("sleep 30", process.cwd(), false, 5000, false, 0, 1024);
  const abort = new AbortController();
  const wait = rt.wait([c.session_id], true, 5000, abort.signal);
  abort.abort();
  await assert.rejects(wait, /cancelled/);
  assert.equal(rt.output(c.session_id, 0, 1024).status, "running");
});

test("latest tail survives log quota exhaustion and consuming legacy readers", async t => {
  const rt = new ProcessRuntime();
  t.after(() => rt.close());
  const job = await rt.start("head -c 9437184 /dev/zero | tr '\\000' x; printf last-diagnostic",
    process.cwd(), false, 10_000, false, 10_000, 64_000);
  const head = rt.output(job.session_id, 0, 64_000);
  assert.equal(head.output_scope, "log");
  assert.ok(head.dropped_bytes > 1024 * 1024);
  await rt.poll(job.session_id, 0, 1024 * 1024);
  const tail = rt.output(job.session_id, 0, 128, true);
  assert.equal(tail.output_scope, "tail");
  assert.ok(tail.output.endsWith("last-diagnostic"));
  assert.equal(tail.next_cursor, undefined);
});

test("finite malformed UTF-8 output cannot leave a stuck log cursor", async t => {
  const rt = new ProcessRuntime();
  t.after(() => rt.close());
  const job = await rt.start("printf '\\347'", process.cwd(), false, 5000, false, 5000, 1024);
  const output = rt.output(job.session_id, 0, 1024);
  assert.equal(output.status, "exited");
  assert.equal(output.output, "\ufffd");
  assert.equal(output.next_cursor, Buffer.byteLength(output.output), "transport decodes malformed bytes to replacement UTF-8");
  assert.equal(output.unread_bytes, 0);
});
