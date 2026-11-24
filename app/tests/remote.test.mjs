import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { main, parseArgs } from "../pipeline/nv-pipeline.mjs";
import { milestoneText } from "../pipeline/nv-remote.mjs";

const here = fileURLToPath(new URL("../pipeline", import.meta.url));

/** A machine whose hc only records what it was asked to do. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "nv-remote-")), home = join(root, "home"), calls = [];
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ root: join(root, "projects") }));
  const sys = { home, here, self: null, platform: "win32", has: () => true, now: () => 0, sleep: async () => {},
    hc(args) { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; } };
  const remote = input => main(sys, parseArgs(["remote", JSON.stringify(input)]));
  const stateOf = dir => JSON.parse(readFileSync(join(dir, "pipeline", "state.json"), "utf8"));
  const setState = (dir, fn) => { const s = stateOf(dir); fn(s); writeFileSync(join(dir, "pipeline", "state.json"), JSON.stringify(s)); };
  return { sys, calls, remote, stateOf, setState, run: (...argv) => main(sys, parseArgs(argv)) };
}
const ask = { action: "create", requestId: "m-1", name: "Cat Cafe", idea: "a cozy cat cafe idle game", kind: "game" };

test("create plans an app without starting it; the same request returns it, different content is a conflict", async () => {
  const w = world();
  const first = await w.remote(ask);
  assert.equal(first.created, true);
  assert.deepEqual([first.app.id, first.app.requestId, first.app.status, first.app.mode], ["cat-cafe", "m-1", "idle", "promote"], "promote by default: production still asks the person");
  assert.equal(w.calls.filter(c => c[0] === "run").length, 0, "nothing was started");
  const again = await w.remote(ask);
  assert.deepEqual([again.created, again.app.id], [false, "cat-cafe"]);
  await assert.rejects(w.remote({ ...ask, idea: "something else" }), /^Error: \[conflict\] requestId m-1 already made cat-cafe/);
  const other = await w.remote({ ...ask, requestId: "m-2" });
  assert.deepEqual([other.created, other.app.id], [true, "cat-cafe-2"], "the idea text alone never dedupes");
});

test("get tells status and what actually finished; unknown requests are not_found", async () => {
  const w = world();
  const { app } = await w.remote(ask);
  const got = await w.remote({ action: "get", requestId: "m-1" });
  assert.equal(got.app.finishedText, "구현 안 됨 · 검증 안 됨 · 제출 안 함");
  w.setState(app.dir, s => { s.stages.build.status = "done"; s.stages.test.status = "done"; s.stages.internal.status = "done"; });
  assert.equal(milestoneText(w.stateOf(app.dir)), "구현 완료 · 검증 완료 · 제출 완료 (internal)");
  await assert.rejects(w.remote({ action: "get", requestId: "nope" }), /\[not_found\]/);
  await assert.rejects(w.remote({ action: "get", requestId: "m-1", id: "cat-cafe" }), /exactly one/);
});

test("resume starts the conductor in the board's terminal, and refuses gates, failures, done apps and stale revisions", async () => {
  const w = world();
  const { app } = await w.remote(ask);
  await assert.rejects(w.remote({ action: "resume", requestId: "m-1", expectedRevision: "old" }), /\[conflict\] cat-cafe changed since/);
  const started = await w.remote({ action: "resume", requestId: "m-1" });
  assert.equal(started.action, "started");
  const run = w.calls.find(c => c[0] === "run");
  assert.equal(run[run.indexOf("--name") + 1], `pipe-${w.stateOf(app.dir).tag}`);
  assert.equal(run[run.indexOf("--cwd") + 1], app.dir);
  assert.deepEqual(run.slice(-2), ["run", "cat-cafe"]);
  w.setState(app.dir, s => { s.status = "waiting"; s.gate = { kind: "pick", stage: "research" }; });
  await assert.rejects(w.remote({ action: "resume", id: "cat-cafe" }), /waits for the person: pick at research/);
  w.setState(app.dir, s => { s.status = "failed"; s.gate = null; s.stage = "build"; });
  await assert.rejects(w.remote({ action: "resume", id: "cat-cafe" }), /nv-pipeline retry cat-cafe/);
  w.setState(app.dir, s => { s.status = "done"; });
  await assert.rejects(w.remote({ action: "resume", id: "cat-cafe" }), /already done/);
});

test("bad requests are refused with a code; no request returns the help", async () => {
  const w = world();
  assert.match((await w.run("remote")).help, /Auto app remote control/);
  await assert.rejects(w.remote({ ...ask, extra: 1 }), /\[invalid_params\] unknown fields for create: extra/);
  await assert.rejects(w.remote({ ...ask, mode: "yolo" }), /mode is one of/);
  await assert.rejects(w.remote({ ...ask, requestId: "has space" }), /requestId must be/);
  await assert.rejects(w.run("remote", "{not json"), /must be JSON/);
});
