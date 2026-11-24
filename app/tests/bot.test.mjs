import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MENTION, ask, create, hook, hooks, list } from "../pipeline/nv-bot.mjs";

const bin = fileURLToPath(new URL("../pipeline", import.meta.url));

/** A machine whose hc keeps a list of live terminals and records every call. */
function world({ live = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "nv-bot-")), calls = [], alive = new Set(live);
  let clock = 1_000_000;
  const sys = { home: join(root, "bots"), bin, user: join(root, "user"), platform: "darwin", now: () => clock++,
    hc(args) {
      calls.push(args);
      if (args[0] === "get") return alive.has(args[1]) ? { code: 0, stdout: JSON.stringify({ state: "live" }), stderr: "" } : { code: 1, stdout: "", stderr: "no such terminal" };
      if (args[0] === "run") alive.add(args[args.indexOf("--name") + 1]);
      return { code: 0, stdout: "{}", stderr: "" };
    } };
  return { root, sys, calls };
}

test("@@name at the start of a prompt is a mention; other @ text is not", () => {
  assert.deepEqual(MENTION.exec("@@scout find the crash").slice(1), ["scout", "find the crash"]);
  assert.deepEqual(MENTION.exec("  @@Auto-App\nline two").slice(1), ["Auto-App", "line two"]);
  for (const text of ["@scout hi", "mail me@@scout", "@@scout:", "look at @@scout"]) assert.equal(MENTION.exec(text), null, text);
});

test("the hook sends a mention to the bot, starting it the first time, and the agent never sees the prompt", async () => {
  const w = world();
  create(w.sys, "scout", { purpose: "Finds crashes." });
  assert.equal(await hook(w.sys, { prompt: "fix the login" }, {}), null, "a normal prompt goes through");
  const first = await hook(w.sys, { prompt: "@@scout why does it crash?", cwd: "/p/app" }, { HC_TERMINAL_ID: "t9" });
  assert.equal(first.decision, "block");
  assert.match(first.reason, /→ @@scout: started and sent \(bot-scout, m-/);
  const run = w.calls.find(c => c[0] === "run");
  assert.equal(run[run.indexOf("--name") + 1], "bot-scout");
  assert.ok(run.includes("--no-parent"), "the bot outlives the terminal that called it");
  assert.equal(run[run.indexOf("--cwd") + 1], w.sys.home, "every bot starts in the bots folder, so one trust answer covers them all");
  const prompt = run.at(-1);
  assert.match(prompt, /You are the bot @@scout/);
  assert.match(prompt, /\[@@scout\] request m-\S+ from t9 working in \/p\/app:\nwhy does it crash\?\nAnswer with: hc send t9/);
  assert.deepEqual(run.slice(run.indexOf("--") + 1, run.indexOf("--") + 3), ["/bin/sh", "-c"], "started through the login shell, so claude is found");
  const second = await hook(w.sys, { prompt: "@@scout and the logout?" }, { HC_TERMINAL_ID: "t9" });
  assert.match(second.reason, /→ @@scout: sent/);
  const send = w.calls.find(c => c[0] === "send");
  assert.equal(send[1], "bot-scout");
  assert.match(send[2], /and the logout\?/);
});

test("an unknown bot or an empty message is answered, never passed to the agent", async () => {
  const w = world();
  create(w.sys, "scout");
  const unknown = await hook(w.sys, { prompt: "@@nobody hi" }, {});
  assert.match(unknown.reason, /no bot named @@nobody \(bots: @@scout\)/);
  assert.match((await hook(w.sys, { prompt: "@@scout   " }, {})).reason, /needs a message/);
  assert.equal(w.calls.filter(c => c[0] === "run").length, 0);
});

test("@@autoapp is made on first use and is told to use the Auto app's remote contract", async () => {
  const w = world();
  const sent = await ask(w.sys, "autoapp", "a cozy fishing game", { from: "t3" });
  assert.equal(sent.started, true);
  const soul = readFileSync(join(w.sys.home, "autoapp", "SOUL.md"), "utf8");
  assert.match(soul, /nv-pipeline\.mjs" remote/);
  assert.match(soul, /Never: approve production/);
  assert.deepEqual(list(w.sys).map(b => b.name), ["autoapp"]);
  assert.throws(() => create(w.sys, "autoapp"), /already exists/);
  assert.throws(() => create(w.sys, "Bad Name"), /a bot name is/);
});

test("hooks install appends to what is there, once; remove takes only ours; broken files are left alone", () => {
  const w = world();
  mkdirSync(join(w.sys.user, ".claude"), { recursive: true });
  mkdirSync(join(w.sys.user, ".codex"), { recursive: true });
  const claude = join(w.sys.user, ".claude", "settings.json"), codex = join(w.sys.user, ".codex", "hooks.json");
  const theirs = { type: "command", command: "their-hook" };
  writeFileSync(claude, JSON.stringify({ theme: "dark", hooks: { UserPromptSubmit: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }] } }));
  writeFileSync(codex, "{ broken");
  const installed = hooks(w.sys, "install");
  assert.deepEqual(installed.map(h => [h.agent, h.installed ?? h.error]), [["claude", true], ["codex", "not a JSON object; left as it is"]]);
  const saved = JSON.parse(readFileSync(claude, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.deepEqual(saved.hooks.Stop, [{ hooks: [theirs] }]);
  assert.equal(saved.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(saved.hooks.UserPromptSubmit[0], { hooks: [theirs] }, "existing hooks keep their position");
  assert.match(saved.hooks.UserPromptSubmit[1].hooks[0].command, /^node ".*nv-bot\.mjs" hook$/);
  assert.ok(existsSync(claude + ".bak-nv-bot"));
  assert.equal(readFileSync(codex, "utf8"), "{ broken");
  assert.equal(hooks(w.sys, "install")[0].changed, false, "installing again changes nothing");
  hooks(w.sys, "remove");
  assert.deepEqual(JSON.parse(readFileSync(claude, "utf8")).hooks.UserPromptSubmit, [{ hooks: [theirs] }]);
});
