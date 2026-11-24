#!/usr/bin/env node
// nv-bot: bots you call by typing @@name in Claude Code or Codex inside herdr. A bot is a long-lived
// agent with a name, a purpose (SOUL.md) and a memory (MEMORY.md) in its own folder; it runs in the
// hc terminal bot-<name> and answers the sender with hc send. Typing "@@scout find the crash" is
// caught by a UserPromptSubmit hook before the agent sees it and goes to @@scout instead.
//
//   nv-bot new <name> [--agent claude|codex|…] [--purpose "<text>"] [--cwd <dir>]
//   nv-bot ls [--json]
//   nv-bot ask <name> <text…> [--from <terminal>] [--cwd <dir>]
//   nv-bot hook                          the UserPromptSubmit hook (reads the hook's JSON on stdin)
//   nv-bot hooks install|remove|status   that hook in ~/.claude/settings.json and ~/.codex/hooks.json
//
// Built in: @@autoapp turns a request into an Auto app run (nv-pipeline remote); it is made on first use.
// Home: ~/.config/herdr-app/bots/<name>/ (bot.json, SOUL.md, MEMORY.md), one machine's bots only.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NAME = /^[a-z][a-z0-9_-]{0,23}$/;   // the terminal bot-<name> stays within hc's 32 characters
export const MENTION = /^\s*@@([a-z][a-z0-9_-]{0,23})(?=\s|$)\s*([\s\S]*)$/i;
const HOOK_MARK = "nv-bot.mjs\" hook";
const HOOK_TIMEOUT = 30;

export class UsageError extends Error {}

export function realSystem(env = process.env) {
  const app = env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  return {
    home: join(app, "bots"), bin: dirname(fileURLToPath(import.meta.url)), user: homedir(), platform: process.platform, now: () => Date.now(),
    hc(args) {
      const r = spawnSync("hc", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
    },
  };
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); };
const botDir = (sys, name) => join(sys.home, name);
const terminalOf = name => `bot-${name}`;
const pipelineTool = sys => join(sys.bin, "nv-pipeline.mjs");

/** Bots that come with the pack: made the first time someone calls them. */
const TEMPLATES = {
  autoapp: sys => ({
    agent: "claude",
    purpose: "Turns a request for an app or a game into an Auto app run and reports how it goes.",
    soul: `# @@autoapp

You turn a person's request into an Auto app run (herdr-toris-neon's app pipeline: research → brief →
design → assets → build → test → store → internal → release) and report how it goes. You never build
the app yourself: the pipeline's own team does.

Tool: \`node "${pipelineTool(sys)}" remote '<json>'\` (run it without the JSON for its help).

1. From the request decide: \`name\` (short, new; never a reference app's name), \`idea\` (the person's
   words plus what you understood), \`kind\` (app, game or auto), \`refs\` (links or image paths they
   gave), \`dir\` only when they named a folder. Ask the sender (hc send) only when the request has no idea at all.
2. Use the request id from the message (\`request m-…\`) as \`requestId\`, so a repeated message never
   makes a second app. \`{"action":"create",…}\`, then \`{"action":"resume","requestId":…}\` to start it.
3. Answer with the app id, its folder and that it shows on the Auto app board (Ctrl/Cmd+Shift+Y).
4. "How is it going?": \`{"action":"get",…}\` and answer with \`status\`, \`gate\` and \`finishedText\`.
5. A gate (pick an idea or a design, approve production) is the person's: pass on the options and act
   only on their answer: \`node "${pipelineTool(sys)}" pick <id> <option>\` or \`approve <id>\`, then resume.
   A failed stage: tell them why (\`status <id> --json\`) and run \`retry <id>\` only when they ask.

Never: approve production, switch the mode to \`auto\`, remove or stop an app, or upload anything,
unless the person asked for exactly that in their own message.
`,
  }),
};

function soulOf(name, purpose) {
  return `# @@${name}\n\n${purpose || "(Write here what this bot is for, how it works and what it must never do.)"}\n`;
}

/** A bot's folder with its three files. Never replaces an existing bot. */
export function create(sys, name, { agent = "claude", purpose = null, cwd = null, soul = null } = {}) {
  if (!NAME.test(name ?? "")) throw new UsageError("a bot name is 1-24 characters: a lowercase letter, then letters, digits, - or _");
  const dir = botDir(sys, name);
  if (existsSync(join(dir, "bot.json"))) throw new UsageError(`@@${name} already exists (${dir})`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(agent)) throw new UsageError(`"${agent}" is not an agent name (claude, codex, …)`);
  const bot = { name, agent, cwd: cwd ? resolve(cwd) : null, createdAt: new Date(sys.now()).toISOString() };
  writeJson(join(dir, "bot.json"), bot);
  writeFileSync(join(dir, "SOUL.md"), soul ?? soulOf(name, purpose));
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\n\nDurable facts and preferences this bot keeps. No secrets.\n");
  return { ...bot, dir };
}

export function list(sys) {
  if (!existsSync(sys.home)) return [];
  return readdirSync(sys.home).map(name => readJson(join(botDir(sys, name), "bot.json"), null)).filter(Boolean)
    .map(bot => ({ ...bot, dir: botDir(sys, bot.name), purpose: purposeOf(sys, bot.name) }));
}
const purposeOf = (sys, name) => (readFileSync(join(botDir(sys, name), "SOUL.md"), "utf8").split(/\r?\n/).find(l => l.trim() && !l.startsWith("#")) ?? "").trim().slice(0, 120);

function load(sys, name) {
  const bot = readJson(join(botDir(sys, name), "bot.json"), null);
  if (bot) return { ...bot, dir: botDir(sys, name) };
  const template = TEMPLATES[name]?.(sys);
  if (template) return create(sys, name, template);
  const known = list(sys).map(b => `@@${b.name}`).join(", ");
  throw new UsageError(`no bot named @@${name}${known ? ` (bots: ${known})` : ""}. Make one: nv-bot new ${name} --purpose "…"`);
}

/** The first prompt a bot gets: who it is and how it answers. */
export function boot(bot) {
  return [
    `You are the bot @@${bot.name}, running in herdr in the terminal ${terminalOf(bot.name)}. Your folder is ${bot.dir}.`,
    "Read SOUL.md (who you are and what you do) and MEMORY.md (what you remember) there before anything else.",
    `Requests reach you as messages that start with [@@${bot.name}]. Do each one, then answer the sender with the hc send command the message gives (the herdr-hc skill explains hc). Answer even when you could not do it, and say why.`,
    "Keep MEMORY.md short and current: durable facts and preferences only, never secrets or tokens.",
    "For code changes in a project, start a worker there with hc run --bg (its own name and scope) and report its verified result. Stay running between requests.",
  ].join("\n");
}

export function message(bot, id, text, { from = null, cwd = null } = {}) {
  const head = `[@@${bot.name}] request ${id} from ${from ?? "the person (no reply address: answer in your own terminal)"}${cwd ? ` working in ${cwd}` : ""}:`;
  return [head, text, ...(from ? [`Answer with: hc send ${from} "<your answer>"`] : [])].join("\n");
}

/** Sends a request to a bot: typed into its terminal, or its terminal is started with it. */
export async function ask(sys, name, text, { from = null, cwd = null } = {}) {
  if (!String(text ?? "").trim()) throw new UsageError(`@@${name} needs a message: @@${name} <what to do>`);
  const bot = load(sys, String(name).toLowerCase());
  const id = `m-${sys.now().toString(36)}`, terminal = terminalOf(bot.name), body = message(bot, id, text.trim(), { from, cwd });
  const info = readJsonText(sys.hc(["get", terminal, "--json"]).stdout);
  if (info?.state === "live") {
    const r = sys.hc(["send", terminal, body]);
    if (r.code !== 0) throw new Error(`could not reach ${terminal}: ${(r.stderr || r.stdout).trim()}`);
    return { bot: bot.name, terminal, id, started: false };
  }
  if (info) sys.hc(["rm", terminal]);   // a finished one left behind
  const { AGENTS, viaShell } = await import("./nv-pipeline.mjs");
  const template = AGENTS[bot.agent];
  if (!template) throw new UsageError(`@@${bot.name} uses "${bot.agent}", which herdr does not know how to start (${Object.keys(AGENTS).join(", ")})`);
  const prompt = `${boot(bot)}\n\n${body}`, filled = template.includes("{prompt}") ? template.map(a => a === "{prompt}" ? prompt : a) : [...template, prompt];
  // Every bot starts in the bots folder (its own folder is below it): an agent asks once whether to trust a
  // new folder, and that one answer then covers every bot. Project work goes to workers started in the project.
  const r = sys.hc(["run", "--bg", "--json", "--no-notify", "--no-parent", "--name", terminal, "--cwd", bot.cwd ?? sys.home, "--", ...viaShell(filled, sys.platform)]);
  if (r.code !== 0) throw new Error(`could not start ${terminal}: ${(r.stderr || r.stdout).trim()}`);
  return { bot: bot.name, terminal, id, started: true };
}
const readJsonText = text => { try { return JSON.parse(text); } catch { return null; } };

/** The UserPromptSubmit hook: a prompt that starts with @@name goes to that bot, and the agent never sees it. */
export async function hook(sys, input, env = {}) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : null;
  const found = prompt && MENTION.exec(prompt);
  if (!found) return null;
  const name = found[1].toLowerCase(), from = env.HC_TERMINAL_ID || null;
  try {
    const sent = await ask(sys, name, found[2], { from, cwd: typeof input.cwd === "string" ? input.cwd : null });
    const where = from ? "Its answer will arrive here as an hc message." : `No herdr terminal here, so read its answer with: hc read ${sent.terminal}`;
    const first = sent.started ? ` The first bot asks once whether to trust the bots folder: answer it with hc attach ${sent.terminal}.` : "";
    return { decision: "block", reason: `→ @@${name}: ${sent.started ? "started and " : ""}sent (${sent.terminal}, ${sent.id}). ${where}${first}` };
  } catch (error) {
    return { decision: "block", reason: `@@${name}: ${error.message ?? error}` };
  }
}

/** Where the hook goes: Claude Code's user settings and Codex's user hooks, when that agent is here. */
function hookFiles(sys) {
  return [["claude", join(sys.user, ".claude", "settings.json")], ["codex", join(sys.user, ".codex", "hooks.json")]]
    .filter(([, file]) => existsSync(dirname(file)));
}
const isOurs = group => (group?.hooks ?? []).some(h => String(h?.command ?? "").includes(HOOK_MARK));

/** Adds, removes or reports the hook. Appended last, so the positions of existing hooks (which Codex trusts by position) stay. */
export function hooks(sys, action) {
  if (!["install", "remove", "status"].includes(action)) throw new UsageError("hooks takes install, remove or status");
  const command = `node "${join(sys.bin, "nv-bot.mjs")}" hook`;
  return hookFiles(sys).map(([agent, file]) => {
    const config = existsSync(file) ? readJson(file, undefined) : {};
    if (config === undefined || typeof config !== "object" || Array.isArray(config)) return { agent, file, error: "not a JSON object; left as it is" };
    const groups = Array.isArray(config.hooks?.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
    const present = groups.some(isOurs);
    if (action === "status" || (action === "install" && present) || (action === "remove" && !present)) return { agent, file, installed: present, changed: false };
    const next = action === "install" ? [...groups, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT }] }] : groups.filter(g => !isOurs(g));
    const { UserPromptSubmit: _old, ...otherEvents } = config.hooks ?? {};
    const updated = { ...config, hooks: next.length ? { ...otherEvents, UserPromptSubmit: next } : otherEvents };
    if (existsSync(file)) copyFileSync(file, `${file}.bak-nv-bot`);
    writeJson(file, updated);
    return { agent, file, installed: action === "install", changed: true };
  });
}

export function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (["--agent", "--purpose", "--cwd", "--from"].includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  return { command: rest[0] ?? "help", args: rest.slice(1), flags };
}

export async function main(sys, { command, args, flags }, env = {}) {
  switch (command) {
    case "new": return create(sys, args[0], { agent: flags.agent, purpose: flags.purpose, cwd: flags.cwd });
    case "ls": {
      // With the state of each bot's terminal: working, idle, blocked… or null when it is not running.
      const live = (readJsonText(sys.hc(["ls", "--json"]).stdout)?.terminals ?? []).filter(t => t.state === "live");
      return { bots: list(sys).map(b => {
        const t = live.find(x => x.name === terminalOf(b.name));
        return { ...b, terminal: terminalOf(b.name), status: t ? (typeof t.status === "object" ? t.status?.state : t.status) ?? "live" : null };
      }) };
    }
    case "ask": return ask(sys, args[0] ?? "", args.slice(1).join(" "), { from: flags.from || env.HC_TERMINAL_ID || null, cwd: resolve(flags.cwd || ".") });
    case "hooks": return { hooks: hooks(sys, args[0] ?? "status") };
    case "help": case "--help": case "-h": return { help: readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n") };
    default: throw new UsageError(`unknown command: ${command} (nv-bot help)`);
  }
}

function print(result, json) {
  if (json) return console.log(JSON.stringify(result));
  if (result.help) return console.log(result.help);
  if (result.bots) return console.log(result.bots.length ? result.bots.map(b => `@@${b.name.padEnd(16)} ${b.agent.padEnd(8)} ${b.purpose}`).join("\n") : "No bots yet. @@autoapp is made on first use; others: nv-bot new <name> --purpose \"…\"");
  if (result.hooks) return console.log(result.hooks.map(h => `${h.agent.padEnd(7)} ${h.error ?? (h.installed ? "installed" : "not installed")}${h.changed ? " (changed)" : ""}  ${h.file}`).join("\n") || "Neither ~/.claude nor ~/.codex exists here.");
  console.log(Object.entries(result).map(([k, v]) => `${k}: ${v}`).join("  "));
}

// Compared as real paths: on macOS /var and /tmp are links, and import.meta.url is the resolved one.
const realOf = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const invoked = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === realOf(process.argv[1]).toLowerCase();
if (invoked) {
  const sys = realSystem();
  if (process.argv[2] === "hook") {
    // Never stand in the way of a prompt: anything unexpected lets it through unchanged.
    let input = null;
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
    const out = await hook(sys, input, process.env).catch(() => null);
    if (out) console.log(JSON.stringify(out));
    process.exit(0);
  }
  try {
    const parsed = parseArgs(process.argv.slice(2));
    print(await main(sys, parsed, process.env), parsed.flags.json);
  } catch (error) {
    console.error(`nv-bot: ${error?.message ?? error}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
