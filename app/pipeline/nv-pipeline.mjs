#!/usr/bin/env node
// nv-pipeline: takes an app idea from research to the Play Store, one stage at a time, without a
// person. This script is the conductor and spends no tokens: each stage is a fresh agent in its own
// hc terminal that reads pipeline/<stage>/TASK.md, writes pipeline/<stage>/result.json and is then
// ended. Stages hand over through files only, so no conversation grows across the whole run.
//
// A stage can be more than one agent: several workers at once (research, design, assets), a lead
// that splits the work first (assets), and a reviewer whose findings send the workers back for
// another round. The conductor also checks pictures itself (nv-graphics.mjs) and sends a failed
// test back to the developer instead of giving up.
//
//   nv-pipeline new "<name>" --idea "<seed>" [--ref <store link|repo|image>]… [--kind app|game|auto] [--mode auto|promote|review] [--dir <path>]
//                   [--cast <stage>=<agent>[:<model>][*<workers>]]… [--review <stage>=<agent>[:<model>]|none]…
//                   [--replica]               use the eleven Replica skills inside the stages (docs/PIPELINE.md)
//   nv-pipeline replica                        the Replica skill pack: where it is, its version, what is missing, which stage uses which skill
//   nv-pipeline agents [--refresh]             the agent CLIs on this machine and their models
//   nv-pipeline agents add <name> <argv…>      make another CLI castable (the task is its last argument)
//   nv-pipeline cast <id> <stage> <agent>[:<model>][*<workers>] [--review <agent>[:<model>]|none]   before that stage starts
//   nv-pipeline run <id> [--until <stage>]     advance until done, a gate, or a failure
//   nv-pipeline pick <id> <option>             choose an idea or a design at a gate
//   nv-pipeline approve <id>                   allow the production release
//   nv-pipeline mode <id> auto|promote|review  auto: no person · promote: ask before production · review: ask at every choice
//   nv-pipeline say <id> <text>                a note from the person to the agent working now
//   nv-pipeline retry <id> [stage] | stop <id> | remove <id>
//   nv-pipeline key set <service-account.json> | key status
//   nv-pipeline status [id] [--json] | stages
//   nv-pipeline remote '<json>'                for bots: create, get and resume with a requestId (nv-remote.mjs)
//
// Home: ~/.config/herdr-app/pipeline (apps.json, settings.json, secrets/play-key.json, preview/).
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyManifest, writeSheet } from "./nv-graphics.mjs";
import * as replica from "./nv-replica.mjs";
import { RemoteError, remoteRequest } from "./nv-remote.mjs";

// Each stage is one role. `role` is who the board shows doing it.
// split: how several workers share it ("options": each proposes, the proposals are merged;
// "manifest": a lead assigns the manifest's items). checks: the image manifest the conductor verifies.
export const STAGES = [
  { id: "research", role: "Researcher", ko: "리서처", minutes: 25, gate: "pick", split: "options", about: "trending apps and games in Korea and the US → three scored ideas" },
  { id: "brief", role: "Planner", ko: "기획자", minutes: 20, about: "one-page brief for the chosen idea, engine choice, scope, kill criteria" },
  { id: "design", role: "Designer", ko: "디자이너", minutes: 40, gate: "pick", split: "options", about: "three visual directions with a mock image each" },
  { id: "assets", role: "Artist", ko: "아티스트", minutes: 90, split: "manifest", checks: "pipeline/assets/manifest.json", about: "sprites, icons and UI art in the chosen direction" },
  { id: "build", role: "Developer", ko: "개발자", minutes: 240, about: "implement the brief's scope, nothing more" },
  { id: "test", role: "Tester", ko: "QA", minutes: 60, about: "install on a device with adb, walk the core flow, catch crashes and ANRs" },
  { id: "store", role: "Marketer", ko: "마케터", minutes: 60, checks: "pipeline/store/manifest.json", about: "icon, feature graphic, screenshots, listing text, privacy policy on Notion" },
  { id: "internal", role: "Release manager", ko: "릴리스 매니저", minutes: 45, needsKey: true, about: "signed bundle to the Play internal track with fastlane" },
  { id: "release", role: "Publisher", ko: "퍼블리셔", minutes: 20, needsKey: true, gate: "approve", about: "promote the tested build to production" },
];
export const MODES = ["auto", "promote", "review"];
const stageOf = id => STAGES.find(s => s.id === id);

export class UsageError extends Error {}

/** Everything that touches the machine, so tests can replace it. */
export function realSystem(env = process.env) {
  const home = env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  return {
    home: join(home, "pipeline"),
    here: dirname(fileURLToPath(import.meta.url)),
    now: () => Date.now(),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    hc(args) {
      const r = spawnSync("hc", args, { encoding: "utf8", windowsHide: true, timeout: 90000 });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
    },
    self: env.HC_TERMINAL_ID || null,
    platform: process.platform,
    // The board starts this script without the person's shell profile on macOS and Linux, so a
    // program that is not found directly is looked for through their login shell as well.
    has(bin) {
      if (bin in found) return found[bin];
      const win = process.platform === "win32";
      let ok = spawnSync(win ? "where" : "which", [bin], { stdio: "ignore", windowsHide: true }).status === 0;
      if (!ok && !win) ok = spawnSync("/bin/sh", ["-c", LOGIN, "sh", "which", bin], { stdio: "ignore", timeout: 15000 }).status === 0;
      return (found[bin] = ok);
    },
    /** Runs a short command of an agent CLI (listing its models) and returns what it printed. */
    exec(argv, timeout = 25000) {
      const win = process.platform === "win32";
      const r = win ? spawnSync(argv.join(" "), { encoding: "utf8", windowsHide: true, timeout, shell: true })
        : spawnSync("/bin/sh", ["-c", LOGIN, "sh", ...argv], { encoding: "utf8", timeout });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    /** The argv of Python 3.8 or newer, or null: the Replica pack's tools run on it. Looked for once. */
    python() { return python === undefined ? (python = replica.findPython()) : python; },
    /** Runs Python in a folder and returns what it printed. */
    py(args, cwd) {
      const argv = this.python();
      if (!argv) return { code: 127, stdout: "", stderr: "Python 3.8 or newer was not found" };
      const r = spawnSync(argv[0], [...argv.slice(1), ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 32 << 20, env: { ...env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
      return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
    },
  };
}
const found = {};
let python;

// ---------------------------------------------------------------- files and locks

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
// Ids name folders and terminals, so they are plain ASCII (Android tooling dislikes other paths); the display name keeps its script.
export const slug = name => String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";

/** A short tag for an app's terminals (hc names are at most 32 characters). It is saved with the
 *  app and checked against the other apps when the app is made, so two apps never share names. */
export function shortTag(id, taken = []) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = h.toString(36).padStart(6, "0").slice(-6);
  let tag = base;
  for (let n = 2; taken.includes(tag); n++) tag = `${base}${n.toString(36)}`;
  return tag;
}
export const terminalName = (tag, stage, member = "") => `pl-${tag}-${stage}${member ? `-${member}` : ""}`;

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** Creates a lock file that already contains its owner: it never exists empty, so nobody can
 *  mistake a fresh lock for an abandoned one. False when someone else holds it. */
function publish(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content);
  try { linkSync(tmp, file); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}
const ownerOf = file => { const pid = Number(readJson(file, 0)); return Number.isInteger(pid) && pid > 0 ? pid : null; };

/** Runs fn while holding a lock file. Every read-modify-write of shared files goes through one, so
 *  the conductor, the board's commands and a second conductor never overwrite each other. A lock is
 *  only taken over when the process that owns it is gone, never because time passed. */
function locked(file, fn) {
  mkdirSync(dirname(file), { recursive: true });
  const until = Date.now() + 180000;
  while (!publish(file, String(process.pid))) {
    const owner = ownerOf(file);
    if (owner && !alive(owner)) { try { unlinkSync(file); } catch { /* someone else cleaned it */ } continue; }
    if (Date.now() > until) throw new Error(`${file} is held by process ${owner ?? "?"}. If nothing of this pipeline is running (for example after a restart), delete that file and try again.`);
    sleepSync(15);
  }
  try { return fn(); } finally { if (ownerOf(file) === process.pid) { try { unlinkSync(file); } catch { /* already gone */ } } }
}

// How each model's CLI is started so it works without a person. {prompt} is where the task goes.
// claude and grok decide per action in their "auto" mode; codex needs no approval but may only
// write inside the project (its own image tool still works). agy can only run unattended by
// skipping its permission prompts, which is the person’s call: it is listed without that flag and
// not cast by default (see docs/PIPELINE.md to turn it on).
// gemini, opencode and cursor-agent are castable the same way as agy: started without the flag that
// skips every permission prompt, so they stop at the first one and the board shows "needs you".
export const AGENTS = {
  claude: ["claude", "--permission-mode", "auto", "{prompt}"],
  grok: ["grok", "--permission-mode", "auto", "{prompt}"],
  codex: ["codex", "--no-daemon", "-a", "never", "-s", "workspace-write", "{prompt}"],
  agy: ["agy", "-i", "{prompt}"],
  gemini: ["gemini", "--approval-mode", "auto_edit", "-i", "{prompt}"],
  opencode: ["opencode", "--prompt", "{prompt}"],
  "cursor-agent": ["cursor-agent", "{prompt}"],
};
// How each CLI is told which model to use, and where its models come from: a command that lists
// them, or names known to work. Anything else can be typed.
export const MODEL_FLAG = { claude: "--model", grok: "-m", codex: "-m", agy: "--model", gemini: "-m", "cursor-agent": "--model" };
const MODEL_LIST = { grok: ["grok", "models"], agy: ["agy", "models"], "cursor-agent": ["cursor-agent", "models"] };
const MODEL_NAMES = { claude: ["opus", "sonnet", "haiku"] };
// Who does what: live trends → grok; planning, code and releases (skills, Notion) → claude;
// pictures → codex (it generates images itself). A model that is not installed, or whose try
// failed, is replaced by `fallback`. Any stage can be recast in settings.json, or per app (--cast).
export const CAST = { research: "grok", brief: "claude", design: "codex", assets: "codex", build: "claude", test: "claude", store: "claude", internal: "claude", release: "claude" };
// Who reviews a stage's work before it is handed on: a different model from the one that made it.
export const REVIEW = { assets: "claude", build: "codex" };
const MAX_WORKERS = 4;

function settings(sys) {
  const saved = readJson(join(sys.home, "settings.json"), {});
  return { root: join(homedir(), "projects"), retries: 1, fallback: "claude", rounds: 3, loops: 3, checks: true, ...saved,
    agents: { ...AGENTS, ...(saved.agents ?? {}) }, cast: { ...CAST, ...(saved.cast ?? {}) },
    review: saved.review === false ? {} : { ...REVIEW, ...(saved.review ?? {}) } };
}

/** "claude", "claude:opus", "codex*2", "grok:grok-4.7*3" → { agent, model, count }. */
export function parseCast(text) {
  let spec = String(text ?? "").trim(), count = null;
  const many = /\*(\d+)$/.exec(spec);
  if (many) { count = Number(many[1]); spec = spec.slice(0, many.index); }
  const at = spec.indexOf(":");
  const agent = (at < 0 ? spec : spec.slice(0, at)).trim(), model = at < 0 ? null : spec.slice(at + 1).trim() || null;
  if (!agent) throw new UsageError(`"${text}" names no agent (for example claude, claude:opus or codex*2)`);
  return { agent, model, ...(count ? { count } : {}) };
}

/** The model for a stage and its command line: the cast, unless it is missing or already failed once.
 *  `want` ({ agent, model }) is this app's own choice for the stage, or the reviewer's. */
export function agentFor(sys, stageId, tries = 1, want = null) {
  const set = settings(sys);
  if (Array.isArray(set.agent)) return { name: "custom", model: null, argv: prompt => [...set.agent, prompt] };   // one command for every stage
  const usable = name => Array.isArray(set.agents[name]) && sys.has(set.agents[name][0]);
  const wanted = want?.agent ?? set.cast[stageId] ?? set.fallback;
  const name = tries === 1 && usable(wanted) ? wanted : usable(set.fallback) ? set.fallback : wanted;
  const template = set.agents[name] ?? AGENTS.claude;
  // The model goes with the agent it was chosen for, not with a stand-in.
  const flag = MODEL_FLAG[name], model = name === wanted && want?.model && flag && !template.includes(flag) ? want.model : null;
  const base = model ? [template[0], flag, model, ...template.slice(1)] : template;
  return { name, model, argv: prompt => base.includes("{prompt}") ? base.map(a => a === "{prompt}" ? prompt : a) : [...base, prompt] };
}

/** Who works on a stage of this app: the agent and model, how many workers, and the reviewer. */
export function castFor(sys, state, stageId) {
  const set = settings(sys), own = state?.cast?.[stageId] ?? {}, stage = stageOf(stageId);
  const count = stage.split ? Math.min(MAX_WORKERS, Math.max(1, Number(own.count) || 1)) : 1;
  const review = own.review ?? set.review[stageId] ?? "none";
  return { want: own.agent ? { agent: own.agent, model: own.model ?? null } : null, count,
    reviewer: !review || review === "none" ? null : parseCast(review), lead: stage.split === "manifest" && count > 1 };
}

/** The agent CLIs of this machine. A CLI's own list of models is slow to get, so it is kept for six hours. */
function agentList(sys, refresh = false) {
  const set = settings(sys), cacheFile = join(sys.home, "models.json"), cache = readJson(cacheFile, {});
  let changed = false;
  const agents = Object.entries(set.agents).filter(([, argv]) => Array.isArray(argv) && argv.length).map(([name, argv]) => {
    const installed = sys.has(argv[0]);
    let models = MODEL_NAMES[name] ?? [];
    if (installed && MODEL_LIST[name] && sys.exec) {
      const kept = cache[name];
      if (!refresh && kept && sys.now() - kept.at < 6 * 3600000) models = kept.models;
      else {
        const r = sys.exec(MODEL_LIST[name]);
        models = r.code === 0 ? modelNames(r.stdout) : kept?.models ?? [];
        if (r.code === 0) { cache[name] = { at: sys.now(), models }; changed = true; }
      }
    }
    return { name, bin: argv[0], installed, models, model: Boolean(MODEL_FLAG[name]), builtin: name in AGENTS };
  });
  if (changed) writeJson(cacheFile, cache);
  const team = Object.fromEntries(STAGES.map(s => [s.id, { agent: agentFor(sys, s.id).name, split: Boolean(s.split), review: set.review[s.id] ?? "none" }]));
  return { agents, team, fallback: set.fallback, maxWorkers: MAX_WORKERS };
}

/** Model ids out of a CLI's "models" listing: the first word of each line that looks like an id. */
export function modelNames(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const word = line.replace(/^[\s*•-]+/, "").split(/\s+/)[0] ?? "";
    if (/^[a-z0-9][\w./:-]*$/i.test(word) && /[\d-]/.test(word) && !out.includes(word)) out.push(word);
  }
  return out.slice(0, 40);
}

/** Makes another CLI castable. Its task is given as the last argument. */
function addAgent(sys, name, argv) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name ?? "") || !argv.length) throw new UsageError("agents add needs a name and the command: nv-pipeline agents add mycli mycli --flag");
  return locked(join(sys.home, "settings.lock"), () => {
    const file = join(sys.home, "settings.json"), saved = readJson(file, {});
    if (name in AGENTS || saved.agents?.[name]) return { added: false, name };
    writeJson(file, { ...saved, agents: { ...(saved.agents ?? {}), [name]: argv } });
    return { added: true, name };
  });
}

const registryFile = sys => join(sys.home, "apps.json");
const registry = sys => readJson(registryFile(sys), []);
const keyFile = sys => join(sys.home, "secrets", "play-key.json");
const stateFile = dir => join(dir, "pipeline", "state.json");
const feedFile = dir => join(dir, "pipeline", "feed.jsonl");

function appOf(sys, id) {
  const app = registry(sys).find(a => a.id === id);
  if (!app) throw new UsageError(`no pipeline named ${id} (nv-pipeline status)`);
  return app;
}
function load(app) {
  const state = readJson(stateFile(app.dir), null);
  if (!state) throw new Error(`${stateFile(app.dir)} is missing or unreadable`);
  return state;
}
/** The only way state is written: read what is on disk now, change it, write it, all under the lock.
 *  Nobody keeps a copy across a stage, so a mode change or a stop made meanwhile is never lost. */
function change(app, fn, event) {
  return locked(join(app.dir, "pipeline", "state.lock"), () => {
    const state = load(app);
    fn(state);
    if (event) state.log = [...(state.log ?? []), { at: new Date().toISOString(), text: event }].slice(-60);
    state.updatedAt = new Date().toISOString();
    writeJson(stateFile(app.dir), state);
    return state;
  });
}

/** One line of the team's feed: who said or handed what to whom. Agents append notes to the same file. */
function feed(app, entry) {
  mkdirSync(dirname(feedFile(app.dir)), { recursive: true });
  appendFileSync(feedFile(app.dir), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// ---------------------------------------------------------------- the Play service account key

/** Checks a Play service-account key file and returns who it is for. */
export function readKey(file) {
  let key;
  try { key = JSON.parse(readFileSync(file, "utf8")); } catch { throw new UsageError(`${file} is not a JSON file`); }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new UsageError("this is not a Google service account key (it needs type: service_account, client_email and private_key). Create one in Google Cloud > IAM > Service accounts > Keys, then invite its email in Play Console > Users and permissions.");
  }
  return { email: key.client_email, project: key.project_id ?? null };
}
/** Stores the key so that it is never readable by others, not even for a moment: the folder is
 *  owner-only before anything is written, and the file is created owner-only. */
function setKey(sys, file) {
  const info = readKey(file);
  const posix = sys.platform !== "win32", dir = dirname(keyFile(sys));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) chmodSync(dir, 0o700);
  const tmp = join(dir, `.play-key.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, readFileSync(file)); } finally { closeSync(fd); }
  if (posix) chmodSync(tmp, 0o600);
  renameSync(tmp, keyFile(sys));
  return info;
}
const keyStatus = sys => existsSync(keyFile(sys)) ? { present: true, ...readKey(keyFile(sys)), path: keyFile(sys) } : { present: false };

// ---------------------------------------------------------------- tasks for the stage agents

/** Fills {{name}} style placeholders; unknown ones stay visible so a broken template is noticed. */
export function render(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (whole, path) => {
    const v = path.split(".").reduce((o, k) => (o == null ? o : o[k]), values);
    return v == null ? whole : typeof v === "string" ? v : JSON.stringify(v, null, 2);
  });
}

/** A path as one literal shell argument: single quotes, which neither bash nor PowerShell expand. */
export function shellQuote(text, platform = process.platform) {
  return platform === "win32" ? `'${String(text).replaceAll("'", "''")}'` : `'${String(text).replaceAll("'", "'\\''")}'`;
}

// ---------------------------------------------------------------- the members of a stage
//
// A member is one agent in one terminal: a worker ("" when it works alone, else w1…w4), the lead
// ("ld", who splits a manifest stage among the workers) or the reviewer ("rv").

const WORKER = "worker", LEAD = "lead", REVIEWER = "review";
const partOf = step => step === "lead" ? LEAD : step === "review" ? REVIEWER : WORKER;
const workersOf = count => count > 1 ? Array.from({ length: count }, (_x, i) => ({ id: `w${i + 1}`, part: WORKER })) : [{ id: "", part: WORKER }];

/** Where a member reads its task and writes its result, relative to the project folder. */
export function filesOf(stage, member) {
  const base = `pipeline/${stage.id}`;
  if (member.part === REVIEWER) return { task: `${base}/TASK-review.md`, result: `${base}/review.json` };
  if (member.part === LEAD) return { task: `${base}/TASK-lead.md`, result: `${base}/result-lead.json` };
  return member.id ? { task: `${base}/TASK-${member.id}.md`, result: `${base}/result-${member.id}.json` } : { task: `${base}/TASK.md`, result: `${base}/result.json` };
}
const fixesFile = stage => `pipeline/${stage.id}/fixes.md`;

// What a reviewer looks at, per stage. A stage without an entry is checked against its own task.
const FOCUS = {
  assets: "Open `pipeline/assets/sheet.html` and the images themselves. Do they share one style (palette, outline, lighting, pixel size) as `pipeline/assets/style.md` and the chosen direction say? Is anything the brief's screens need missing, unreadable at its real size, cut off, or left with a background that should be transparent?",
  build: "Run the analyzer or linter, the unit tests and the debug build yourself. Go through the scope checklist of `pipeline/brief/brief.md` item by item: is each one really implemented and reachable in the app? Is anything from the out-of-scope list in? Look for crashes on start, dead buttons and placeholder text.",
  design: "Are the directions clearly different from each other, readable as the real main screen of the brief, and clearly not a copy of a reference?",
  store: "Read the listing as a store visitor: does every claim match what the app does, are the screenshots real ones, and do the lengths and image sizes fit Google Play?",
};

function task(sys, app, state, stage, member = { id: "", part: WORKER }) {
  const stagesDir = existsSync(join(sys.home, "stages")) ? join(sys.home, "stages") : join(sys.here, "stages");
  const read = name => { const own = join(stagesDir, name); return readFileSync(existsSync(own) ? own : join(sys.here, "stages", name), "utf8"); };
  const body = read(member.part === REVIEWER ? "_review.md" : member.part === LEAD ? `${stage.id}-lead.md` : `${stage.id}.md`);
  const chosen = id => (state.options?.[id] ?? []).find(o => o.id === state.choice?.[id]) ?? null;
  const next = STAGES[STAGES.indexOf(stage) + 1];
  const rec = state.stages[stage.id] ?? {}, team = castFor(sys, state, stage.id), round = rec.round ?? 1, files = filesOf(stage, member);
  const hasFixes = existsSync(join(app.dir, fixesFile(stage)));
  const share = member.part !== WORKER || !member.id ? "You work on this stage alone."
    : stage.split === "manifest" ? `You are worker **${member.id}** of ${team.count}. The lead has written \`pipeline/${stage.id}/style.md\` and \`pipeline/${stage.id}/manifest.json\`: read both first, and make **only** the items whose \`owner\` is \`${member.id}\`. Do not touch the manifest or other workers' files.`
    : `You are worker **${member.id}** of ${team.count}, each proposing on its own. Wherever this task names a file under \`pipeline/${stage.id}/\`, add \`-${member.id}\` before its extension (\`ideas.md\` → \`ideas-${member.id}.md\`, \`option-a.png\` → \`option-a-${member.id}.png\`). The conductor merges everyone's options, so make yours distinct and strong rather than safe.`;
  const role = member.part === REVIEWER ? `reviewer of the ${stage.role}'s work` : member.part === LEAD ? `lead ${stage.role}` : stage.role;
  const checks = member.part === REVIEWER ? checksOf(sys, app, stage) : [];
  // A run with Replica gets, between the stage's own task and the rules, the skills of this stage only.
  const skills = state.replica ? replica.taskSection(sys, stage, { member, count: team.count, review: member.part === REVIEWER }) : null;
  return render(`${body}\n\n${skills ? `${skills}\n\n` : ""}${read("_rules.md")}`, {
    name: state.name, id: state.id, idea: state.idea || "(none: propose from what is trending)", kind: state.kind, engine: state.engine ?? "(decided in the brief stage)",
    existing: state.existing ? `This folder is already a **${state.existing.engine}** project${state.existing.package ? ` with the application id \`${state.existing.package}\`` : ""}: keep that engine${state.existing.package ? " and that id" : ""} and put ${state.existing.package ? "them" : "it"} in your result unchanged; the brief plans the next version of it. Otherwise: ` : "",
    dir: app.dir, stage: stage.id, role, next: next ? `${next.role} (${next.id})` : "nobody: this is the last stage", minutes: stage.minutes,
    key: keyFile(sys), package: state.package ?? "(set in the brief stage)",
    idea_choice: chosen("research") ?? "(none)", design_choice: chosen("design") ?? "(none)",
    refs: refsText(state.refs), key_arg: shellQuote(keyFile(sys), sys.platform),
    result: files.result, worker: share, workers: String(team.count), worker_ids: workersOf(team.count).map(w => w.id || "w1").join(", "),
    round: String(round), rounds: String(settings(sys).rounds),
    fixes: hasFixes ? `This is round ${round}. Read \`${fixesFile(stage)}\` first and fix exactly what it lists${member.id ? " (the lines that are yours, or that name nobody)" : ""}. Keep everything that already works.` : "Nothing to fix yet: this is the first round.",
    focus: FOCUS[stage.id] ?? "Compare what was produced with what the stage's task asked for.",
    task_file: filesOf(stage, { id: "", part: WORKER }).task,
    issues: checks.length ? checks.map(i => `- ${i.text}`).join("\n") : "(the automatic checks found nothing)",
  });
}

/** What the conductor checks itself after the workers are done: the stage's image manifest. */
function checksOf(sys, app, stage) {
  if (!stage.checks || settings(sys).checks === false) return [];
  const { items, issues } = verifyManifest(app.dir, stage.checks);
  if (items.length) writeSheet(app.dir, `pipeline/${stage.id}/sheet.html`, `${stage.role}: ${stage.id}`, items, issues);
  return issues;
}

/** Several workers' results as one: the summaries together, and for a choice stage everyone's
 *  options (ids prefixed with the worker), best score first, one of them recommended. */
export function mergeResults(parts) {
  if (parts.length === 1) return parts[0].result;
  const out = { status: "done", summary: parts.map(p => `[${p.id}] ${p.result.summary}`).join(" ").slice(0, 2000) };
  for (const field of ["engine", "package", "title"]) { const hit = parts.find(p => typeof p.result[field] === "string" && p.result[field]); if (hit) out[field] = hit.result[field]; }
  const said = parts.find(p => p.result.replica && typeof p.result.replica === "object");
  if (said) out.replica = said.result.replica;
  const options = parts.flatMap(p => (p.result.options ?? []).map(o => ({ ...o, id: `${p.id}-${o.id}` })));
  if (options.length) {
    options.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const best = options.find(o => o.recommended) ?? options[0], top = options.slice(0, 6);
    if (!top.includes(best)) top[top.length - 1] = best;
    out.options = top.map(o => ({ ...o, recommended: o === best }));
  }
  return out;
}

/** What the person pointed at as a reference: a store page, a repository, a web page, or a picture
 *  (copied into the project so every stage can open it). */
export function reference(value, dir, index) {
  const text = String(value).trim();
  if (/^https?:\/\//i.test(text)) {
    const kind = /play\.google\.com\/store\/apps/i.test(text) ? "play" : /apps\.apple\.com/i.test(text) ? "appstore" : /github\.com\//i.test(text) ? "repo" : "web";
    return { kind, url: text };
  }
  const file = resolve(text.replace(/^~(?=$|[\\/])/, homedir()));
  if (/\.(png|jpe?g|webp|gif)$/i.test(file) && existsSync(file)) {
    const rel = `pipeline/refs/${index + 1}${extname(file).toLowerCase()}`;
    mkdirSync(join(dir, "pipeline", "refs"), { recursive: true });
    copyFileSync(file, join(dir, rel));
    return { kind: "image", file: rel };
  }
  return { kind: "note", text };
}

function refsText(refs) {
  if (!refs?.length) return "(none given)";
  const label = { play: "Google Play page", appstore: "App Store page", repo: "repository (check its license)", web: "web page", image: "picture in the project", note: "note" };
  return "\n" + refs.map(r => `  - ${label[r.kind]}: ${r.url ?? r.file ?? r.text}`).join("\n");
}

// ---------------------------------------------------------------- running one stage

const READY_MS = 4000, POLL_MS = 5000;
// An agent that reports it is not working and has written no result is reminded, then given up on.
// One that reports an error (a usage limit, a busy provider) gets less patience.
const QUIET_MS = 90000, ERROR_MS = 30000;
const NUDGE = "You stopped without writing your result file. If the work is finished, write it now exactly as your task file says. If you cannot finish, write it with status \"failed\" or \"blocked\" and the reason. Do not wait for an answer: nobody is reading this terminal.";
// Questions a CLI asks before it starts in a folder it has not seen; the default answer (enter) is yes.
const STARTUP = [/trust (this|the files in this|the contents of this) (folder|directory)/i, /do you trust/i];

// herdr-core on macOS and Linux does not have the person's PATH (node, claude, flutter live in
// their shell profile). Programs therefore start through their login shell: $SHELL when it is a
// POSIX-style shell, else zsh on macOS (its default; it reads ~/.zprofile), bash, then sh.
const LOGIN = 's="${SHELL:-}"; case "$s" in */zsh|*/bash|*/sh|*/dash|*/ksh) [ -x "$s" ] || s= ;; *) s= ;; esac; ' +
  'if [ -z "$s" ]; then if [ "$(uname)" = Darwin ] && [ -x /bin/zsh ]; then s=/bin/zsh; elif [ -x /bin/bash ]; then s=/bin/bash; else s=/bin/sh; fi; fi; ' +
  'exec "$s" -lc \'exec "$@"\' sh "$@"';
/** A command as hc should start it: unchanged on Windows, through the login shell elsewhere. */
export function viaShell(argv, platform = process.platform) {
  return platform === "win32" ? argv : ["/bin/sh", "-c", LOGIN, "sh", ...argv];
}

const readJsonText = text => { try { return JSON.parse(text); } catch { return null; } };
const lastLines = (sys, terminal) => sys.hc(["read", terminal, "--lines", "0"]).stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-3).join(" / ").slice(0, 300);
const isLive = (sys, terminal) => readJsonText(sys.hc(["get", terminal, "--json"]).stdout)?.state === "live";
const endTerminal = (sys, terminal) => { sys.hc(["kill", terminal]); sys.hc(["rm", terminal]); };
/** Every terminal a stage's record names. */
const terminalsOf = r => [...new Set([r?.terminal, ...(r?.members ?? []).map(m => m.terminal)].filter(Boolean))];
/** What the agent in a terminal reports: working, idle, done, blocked or error. `hc get` gives
 *  { app, state }, `hc ls` the plain word; undefined when the program reports nothing. */
export const statusWord = info => info?.status && typeof info.status === "object" ? info.status.state : info?.status;

/** Starts one member's agent. Called while the state lock is held, so a stop or a mode change
 *  either happens before it (and the agent does not start) or after the terminal is on record
 *  (and stop ends it). */
function launch(sys, app, state, stage, member) {
  const files = filesOf(stage, member), team = castFor(sys, state, stage.id);
  mkdirSync(join(app.dir, "pipeline", stage.id), { recursive: true });
  rmSync(join(app.dir, files.result), { force: true });
  writeFileSync(join(app.dir, files.task), task(sys, app, state, stage, member));
  const who = member.part === REVIEWER ? `reviewer of the ${stage.role}'s work` : member.part === LEAD ? `lead ${stage.role}` : stage.role;
  const prompt = `You are the ${who} ("${stage.id}" stage) of an unattended app pipeline for "${state.name}". Read ${files.task} and do exactly what it says, nothing from other stages. Finish by writing ${files.result}.`;
  const name = terminalName(state.tag ?? shortTag(state.id), stage.id, member.id);
  endTerminal(sys, name);   // a leftover from an interrupted run
  const agent = agentFor(sys, stage.id, state.stages[stage.id].tries ?? 1, member.part === REVIEWER ? team.reviewer : team.want);
  const started = sys.hc(["run", "--bg", "--json", "--no-notify", "--outlive-parent", "--name", name, "--cwd", app.dir, "--", ...viaShell(agent.argv(prompt), sys.platform)]);
  if (started.code !== 0) return { error: `could not start the agent: ${(started.stderr || started.stdout).trim()}` };
  return { terminal: readJsonText(started.stdout)?.address ?? name, agent: agent.name, model: agent.model ?? null };
}

/** Starts every member of one step (the lead, the workers, or the reviewer) and puts them on record.
 *  Called under the state lock. `only`: the workers to start again in a fix round. */
function startStep(sys, app, s, stage, step, only = null) {
  const r = s.stages[stage.id], team = castFor(sys, s, stage.id);
  const wanted = step === "lead" ? [{ id: "ld", part: LEAD }] : step === "review" ? [{ id: "rv", part: REVIEWER }]
    : workersOf(team.count).filter(w => !only || only.includes(w.id));
  const batch = [];
  for (const member of wanted) {
    const made = launch(sys, app, s, stage, member);
    if (made.error) { for (const b of batch) endTerminal(sys, b.terminal); return { error: made.error }; }
    Object.assign(member, { terminal: made.terminal, agent: made.agent, model: made.model, status: "running", round: r.round ?? 1 });
    batch.push({ member: { id: member.id, part: member.part }, terminal: made.terminal, adopted: false });
  }
  const same = (a, b) => a.id === b.id && a.part === b.part;
  r.members = [...(r.members ?? []).filter(x => !wanted.some(m => same(m, x))), ...wanted];
  r.step = step; r.terminal = batch[0]?.terminal ?? null;
  if (step === "work") r.agent = wanted[0].agent;
  return { batch };
}

/** A stage a conductor left unfinished, or whose agent was waiting for the person: its live agents
 *  are taken over and results already written are used. Members of the step that have neither are
 *  started again. Null when nothing of it is left. Called under the state lock. */
function resumeStep(sys, app, s, stage) {
  const r = s.stages[stage.id], step = r.step ?? "work";
  const members = (r.members?.length ? r.members : [{ id: "", part: WORKER, terminal: r.terminal ?? null }]).filter(m => m.part === partOf(step));
  const batch = members.map(member => {
    const live = Boolean(member.terminal) && isLive(sys, member.terminal);
    const left = live ? null : readJson(join(app.dir, filesOf(stage, member).result), null);
    return { member, terminal: live ? member.terminal : null, adopted: live, result: left?.status === "done" ? left : null };
  });
  if (!batch.some(b => b.terminal || b.result)) return null;
  for (const b of batch) {
    if (b.result && b.member.terminal) { endTerminal(sys, b.member.terminal); b.member.terminal = null; }
    if (b.terminal || b.result) continue;
    const made = launch(sys, app, s, stage, b.member);
    if (made.error) b.result = { status: "failed", summary: made.error };
    else { Object.assign(b.member, { terminal: made.terminal, agent: made.agent, model: made.model, status: "running" }); b.terminal = made.terminal; }
  }
  r.members = r.members?.length ? r.members : members;
  r.step = step; r.terminal = batch.find(b => b.terminal)?.terminal ?? null;
  return batch.map(b => ({ member: { id: b.member.id, part: b.member.part }, terminal: b.terminal, adopted: b.adopted, result: b.result }));
}

/** Waits for one member's result file and ends its terminal unless it still needs the person. */
async function watch(sys, app, stage, terminal, adopted, resultFile) {
  const begun = sys.now(), deadline = begun + stage.minutes * 60000;
  let trusted = false, result = null, missing = 0, quietSince = null, nudges = 0;
  try {
    if (!adopted) await sys.sleep(READY_MS);
    for (;;) {
      // A stop comes first: a stopped pipeline takes no result and starts nothing.
      if (load(app).stopRequested) { result = { status: "stopped", summary: "stopped by the person" }; break; }
      const info = readJsonText(sys.hc(["get", terminal, "--json"]).stdout);
      const written = existsSync(resultFile) ? readJson(resultFile, null) : null;
      if (!info || info.error) {
        // The terminal is not there (herdr-core restarted, someone removed it). Not on the first miss.
        if (++missing >= 3) { result = written ?? { status: "failed", summary: "the agent's terminal is gone and it left no result" }; break; }
        await sys.sleep(POLL_MS);
        continue;
      }
      missing = 0;
      const word = statusWord(info);
      if (!trusted && !adopted && sys.now() - begun < 60000) {
        // A new folder asks "do you trust this folder?" before the agent starts.
        const screen = sys.hc(["read", terminal, "--lines", "0"]).stdout;
        if (STARTUP.some(q => q.test(screen))) { sys.hc(["keys", terminal, "enter"]); trusted = true; }
      }
      if (written && word !== "working") { result = written; break; }
      if (info.state === "finished" || info.exit_code != null) {
        result = written ?? { status: "failed", summary: `the agent exited${info.exit_code != null ? ` with code ${info.exit_code}` : ""} without a result: ${lastLines(sys, terminal)}` };
        break;
      }
      if (word === "blocked") { result = { status: "blocked", summary: `the agent is waiting for a person: ${lastLines(sys, terminal)}` }; break; }
      if (sys.now() > deadline) { result = { status: "failed", summary: `no result after ${stage.minutes} minutes (the stage's budget)` }; break; }
      if (word === "idle" || word === "done" || word === "error") {
        // It says it is not working, and there is no result: it stopped on its own (finished its
        // turn without the file, asked a question, or its provider refused).
        quietSince ??= sys.now();
        if (sys.now() - quietSince >= (word === "error" ? ERROR_MS : QUIET_MS)) {
          if (nudges >= (word === "error" ? 1 : 2)) {
            result = { status: "failed", summary: `the agent stopped without a result${word === "error" ? " (it reports an error)" : ""}: ${lastLines(sys, terminal)}` };
            break;
          }
          nudges++; quietSince = sys.now();
          sys.hc(["send", terminal, NUDGE]);
        }
      } else quietSince = null;
      await sys.sleep(POLL_MS);
    }
  } finally {
    // A blocked agent stays so the person can answer it; everything else is ended to free memory.
    if (result?.status !== "blocked") {
      endTerminal(sys, terminal);
      change(app, s => {
        const r = s.stages[stage.id];
        for (const m of r.members ?? []) if (m.terminal === terminal) m.terminal = null;
        if (r.terminal === terminal) r.terminal = (r.members ?? []).find(m => m.terminal)?.terminal ?? null;
      });
    }
  }
  return normalize(result);
}

/** Runs a stage from the step that was just started to its end: lead → workers → the conductor's
 *  own checks → reviewer, and again from the workers while something has to be fixed. Returns the
 *  stage's result as one agent would have written it. */
async function runStage(sys, app, stage, generation, first) {
  const set = settings(sys);
  const note = (code, arg, text) => feed(app, { from: stage.id, kind: "note", code, arg: String(arg ?? ""), text });
  let batch = first, audited = null;
  const workerResults = team => workersOf(team.count).map(w => ({ id: w.id, result: normalize(readJson(join(app.dir, filesOf(stage, w).result), null)) }));
  for (;;) {
    const done = await Promise.all(batch.map(async b => ({ ...b, result: b.result ? normalize(b.result)
      : await watch(sys, app, stage, b.terminal, b.adopted, join(app.dir, filesOf(stage, b.member).result)) })));
    const seen = change(app, s => {
      for (const d of done) { const m = (s.stages[stage.id].members ?? []).find(x => x.id === d.member.id && x.part === d.member.part); if (m) m.status = d.result.status; }
    });
    const r = seen.stages[stage.id], step = r.step ?? "work", round = r.round ?? 1, team = castFor(sys, seen, stage.id);
    const stopped = done.find(d => d.result.status === "stopped");
    if (stopped || seen.stopRequested || (seen.generation ?? 0) !== generation) return { status: "stopped", summary: "stopped by the person" };
    const blocked = done.find(d => d.result.status === "blocked");
    if (blocked) return blocked.result;
    const failed = step === "review" ? null : done.find(d => d.result.status !== "done");
    if (failed) return failed.result;

    let next = null, left = [];
    if (step === "lead") next = { step: "work" };
    else if (step === "work" && team.reviewer) next = { step: "review" };
    else {
      const issues = checksOf(sys, app, stage);
      if (seen.replica) {
        // What the stage's skills had to leave behind, checked with the pack's own tools. A defect in
        // the app itself (a must-have that is not done, an open serious bug) goes to the developer.
        audited = replica.audit(sys, app.dir, seen, stage, normalize(mergeResults(workerResults(team))));
        if (audited.defects.length) return { status: "failed", summary: `${audited.defects.length} thing(s) for the developer: ${audited.defects.slice(0, 3).join("; ")}`.slice(0, 2000), defects: audited.defects, replicaSteps: audited.record, replicaVersion: audited.version };
        issues.push(...audited.issues.map(text => ({ owner: null, text })));
      }
      if (step === "review") {
        const review = done[0].result;
        if (review.status !== "done") note("review.skip", "", `The reviewer did not finish (${review.summary}); going on without a review.`);
        else if (review.verdict === "fix") issues.push(...(Array.isArray(review.issues) ? review.issues : []).slice(0, 12).map(text => ({ owner: null, by: "review", text: String(text) })));
      }
      // An upload stage is never run again for a fix round: it may already have uploaded or promoted.
      // What is wrong is shown to the person, who repairs it and continues (the result that is there is taken).
      if (issues.length && stage.needsKey && audited) return { status: "blocked", summary: `This stage ran, but its record does not check out: ${issues.slice(0, 4).map(i => i.text).join("; ")}. Look at Play Console for what it did, put it right, then continue.`.slice(0, 2000), replicaSteps: audited.record, replicaVersion: audited.version };
      if (issues.length && round < set.rounds) {
        const owners = issues.every(i => i.owner) ? [...new Set(issues.map(i => i.owner))] : null;
        writeFileSync(join(app.dir, fixesFile(stage)), `# ${stage.role}: fix in round ${round + 1}\n\n${issues.map(i => `- ${i.owner ? `[${i.owner}] ` : ""}${i.text}`).join("\n")}\n`);
        note("round", round + 1, `Round ${round + 1}: ${issues.length} thing(s) to fix.`);
        next = { step: "work", round: round + 1, only: owners };
      } else {
        const hard = issues.filter(i => !i.by);
        if (hard.length) return { status: "failed", summary: `the automatic checks still fail after ${round} round(s): ${hard.slice(0, 4).map(i => i.text).join("; ")}`, ...(audited ? { replicaSteps: audited.record, replicaVersion: audited.version } : {}) };
        left = issues;
      }
    }
    if (!next) {
      if (step === "review" && !left.length) note("review.pass", "", "The review passed.");
      const merged = normalize(mergeResults(workerResults(team)));
      if (audited) Object.assign(merged, { replicaSteps: audited.record, replicaVersion: audited.version });
      if (left.length) merged.summary = `${merged.summary} (검토 지적 ${left.length}건이 ${fixesFile(stage)} 에 남았습니다)`.slice(0, 2000);
      else rmSync(join(app.dir, fixesFile(stage)), { force: true });
      return merged;
    }
    // The next step starts under the state lock, like the first one: a stop or a "run again" made
    // meanwhile wins, and the new terminals are on record before the lock is released.
    let made = null;
    change(app, s => {
      if ((s.generation ?? 0) !== generation || s.stopRequested) { made = { obsolete: true }; return; }
      if (next.round) s.stages[stage.id].round = next.round;
      made = startStep(sys, app, s, stage, next.step, next.only);
    });
    if (made.obsolete) return { status: "stopped", summary: "stopped by the person" };
    if (made.error) return { status: "failed", summary: made.error };
    if (next.step === "review") note("review.start", "", "The reviewer is checking the work.");
    batch = made.batch;
  }
}

/** A result file as the conductor understands it; anything malformed counts as a failure. */
export function normalize(result) {
  if (!result || typeof result !== "object") return { status: "failed", summary: "result.json is not an object" };
  const status = ["done", "failed", "blocked", "stopped"].includes(result.status) ? result.status : "failed";
  const out = { ...result, status, summary: String(result.summary ?? "").slice(0, 2000) };
  if (Array.isArray(result.options)) {
    out.options = result.options.filter(o => o && o.id && o.title).slice(0, 6).map(o => ({
      id: String(o.id), title: String(o.title), desc: String(o.desc ?? "").slice(0, 600), score: Number.isFinite(Number(o.score)) && o.score != null ? Number(o.score) : null,
      image: o.image ? String(o.image) : null, recommended: Boolean(o.recommended),
    }));
  }
  return out;
}

/** The option an unattended run takes: the recommended one, else the best score, else the first. */
export function autoPick(options) {
  if (!options?.length) return null;
  return (options.find(o => o.recommended) ?? [...options].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]).id;
}

/** Copies option images where the board can show them (mods load images from the app home only). */
function preview(sys, app, state, stage, options) {
  const dir = join(sys.home, "preview", state.id);
  return options.map(o => {
    if (!o.image) return o;
    const from = isAbsolute(o.image) ? o.image : join(app.dir, o.image);
    if (!existsSync(from)) return { ...o, image: null };
    mkdirSync(dir, { recursive: true });
    const name = `${stage.id}-${o.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${Math.round(statSync(from).mtimeMs)}${extname(from) || ".png"}`;
    copyFileSync(from, join(dir, name));
    return { ...o, preview: `pipeline/preview/${state.id}/${name}` };
  });
}

// ---------------------------------------------------------------- the conductor

const runLock = app => join(app.dir, "pipeline", "run.lock");
/** The process conducting this app now, if it is alive. */
const conductor = app => { const pid = ownerOf(runLock(app)); return pid && alive(pid) ? pid : null; };

/** One conductor per project: a lock file that names the process holding it from the moment it exists. */
function takeRunLock(app, id) {
  const file = runLock(app);
  for (let i = 0; i < 5; i++) {
    if (publish(file, String(process.pid))) return () => { if (ownerOf(file) === process.pid) { try { unlinkSync(file); } catch { /* already gone */ } } };
    const owner = ownerOf(file);
    if (!owner || alive(owner)) throw new UsageError(`${id} is already running${owner ? ` (process ${owner})` : ""}. If it is not (for example after a restart), delete ${file} and try again.`);
    try { unlinkSync(file); } catch { /* someone else cleaned it */ }
  }
  throw new UsageError(`${id} is already running`);
}

/** Advances a pipeline until it is done, needs a person, fails, or reaches `until`. */
export async function advance(sys, id, { until = null } = {}) {
  const app = appOf(sys, id);
  load(app);
  const release = takeRunLock(app, id);
  const gate = g => {
    change(app, s => { s.status = "waiting"; s.gate = g; s.stage = g.stage; }, `${g.stage}: waiting for the person (${g.kind})`);
    feed(app, { from: g.stage, to: "person", kind: "ask", code: `ask.${g.kind}`, text: { pick: "Please choose one.", approve: "Ready for production. Approve?", key: "I need the Play service account key.", blocked: "I'm stuck and need you." }[g.kind] });
  };
  try {
    change(app, s => { s.runner = sys.self; s.status = "running"; s.gate = null; s.stopRequested = false; }, "running");
    for (;;) {
      const seen = load(app);
      if (seen.stopRequested) { change(app, s => { s.status = "stopped"; }, "stopped"); break; }
      const stage = STAGES.find(s => seen.stages[s.id].status !== "done");
      if (!stage) {
        change(app, s => { s.status = "done"; s.stage = null; }, "pipeline done");
        feed(app, { from: "release", kind: "done", code: "done", text: "Pipeline finished." });
        break;
      }
      const next = STAGES[STAGES.indexOf(stage) + 1];
      if (seen.stages[stage.id].status === "waiting" && stage.gate === "pick") {
        if (seen.mode === "review") { gate({ kind: "pick", stage: stage.id }); break; }
        // The mode no longer asks: take the options that are already there.
        const options = seen.options?.[stage.id] ?? [], chosen = options.find(o => o.id === autoPick(options));
        change(app, s => { s.choice = { ...(s.choice ?? {}), [stage.id]: chosen.id }; s.stages[stage.id].status = "done"; s.gate = null; }, `${stage.id}: chose ${chosen.id} (unattended)`);
        feed(app, { from: stage.id, kind: "choice", code: "pick.auto", arg: chosen.title, text: `Chose "${chosen.title}" (unattended).` });
        feed(app, { from: stage.id, to: next?.id ?? null, kind: "handoff", text: seen.stages[stage.id].summary ?? "" });
        continue;
      }
      // With Replica, nothing is uploaded unless the code is exactly what the tests passed on and
      // nothing of the reference is left in it. Otherwise the developer and the tester go again.
      if (seen.replica && stage.id === "internal" && seen.stages.internal.status === "pending") {
        const pre = replica.preflight(sys, app.dir);
        if (pre.back.length) {
          const spent = (seen.loops ?? 0) >= settings(sys).loops, loop = (seen.loops ?? 0) + 1, why = pre.back.join(" ").slice(0, 2000);
          let obsolete = false;
          if (!spent) {
            mkdirSync(join(app.dir, "pipeline", "build"), { recursive: true });
            writeFileSync(join(app.dir, fixesFile(stageOf("build"))), `# Developer: before the upload (loop ${loop})\n\nThe app may not be uploaded as it is. Repair this, then the tester checks the new build:\n\n${pre.back.map(l => `- ${l}`).join("\n")}\n`);
          }
          change(app, s => {
            if ((s.generation ?? 0) !== (seen.generation ?? 0) || s.stopRequested) { obsolete = true; return; }
            if (spent) { Object.assign(s.stages.internal, { status: "failed", error: why, summary: why }); s.status = "failed"; return; }
            s.loops = loop; s.stage = "build";
            s.stages.build = { status: "pending", tries: 0 };
            s.stages.test = { status: "pending", tries: 0, summary: s.stages.test?.summary };
          }, spent ? `internal: not uploaded (${why.slice(0, 200)})` : `internal: sent back to build before the upload (loop ${loop})`);
          if (obsolete) { change(app, s => { if (s.stopRequested) s.status = "stopped"; }); break; }
          feed(app, spent ? { from: "internal", kind: "fail", text: why } : { from: "internal", to: "build", kind: "handoff", code: "loop.preflight", arg: String(pre.back.length), text: `Not uploaded: ${pre.back.length} thing(s) to repair first (loop ${loop}).` });
          if (spent) break;
          continue;
        }
      }
      // Checking that the stage may run and starting it are ONE step under the state lock: the mode,
      // an approval or a stop is read at the moment the agent is started, and the terminal is on
      // record before the lock is released, so a stop that comes next ends it.
      let go = null;
      const started = change(app, s => {
        const r = s.stages[stage.id];
        if (s.stopRequested) { go = { stop: true }; return; }
        if (STAGES.find(x => s.stages[x.id].status !== "done")?.id !== stage.id) { go = { again: true }; return; }
        if (stage.needsKey && !existsSync(keyFile(sys))) { go = { gate: "key" }; return; }
        if (stage.gate === "approve" && s.mode !== "auto" && !s.approved?.[stage.id]) { go = { gate: "approve" }; return; }
        // A Replica run waits, and says for what, when the skill pack or Python is not on this machine.
        const lack = s.replica ? replica.doctor(sys).missing[0] : null;
        if (lack) { r.status = "blocked"; r.terminal = null; r.error = `Replica: ${lack}`; go = { gate: "blocked" }; return; }
        // An agent that was waiting for the person is taken over if it is still there; if it has
        // finished its work meanwhile, that result is used. It is not started again.
        // The same goes for a stage a conductor left "running" when it died: its agent or its result
        // is picked up. An upload stage in that state is never simply started again, because the
        // first try may already have uploaded or promoted: the person checks and chooses "run again".
        const unfinished = r.status === "blocked" || r.status === "running";
        const resumed = unfinished ? resumeStep(sys, app, s, stage) : null;
        if (r.status === "running" && !resumed && stage.needsKey) {
          r.status = "blocked"; r.terminal = null;
          r.error = "The last run stopped in the middle of this upload stage. Check Play Console for what it did, then choose Run again.";
          go = { gate: "blocked" }; return;
        }
        s.stage = stage.id; s.status = "running"; s.gate = null;
        r.status = "running"; r.endedAt = null; r.error = null;
        if (resumed) { go = { batch: resumed }; return; }
        r.tries = (r.tries ?? 0) + 1; r.startedAt = new Date().toISOString();
        r.round = 1; r.members = [];
        // The design that was chosen (by the person or unattended) settles the project's tokens here.
        const settled = s.replica && stage.id === "assets" ? replica.settleDesign(app.dir, s) : null;
        if (settled?.error) { go = { result: { status: "failed", summary: settled.error } }; return; }
        const made = startStep(sys, app, s, stage, castFor(sys, s, stage.id).lead ? "lead" : "work");
        if (made.error) { go = { result: { status: "failed", summary: made.error } }; return; }
        go = { batch: made.batch, fresh: true };
      });
      if (go.stop) { change(app, s => { s.status = "stopped"; }, "stopped"); break; }
      if (go.again) continue;
      if (go.gate) { gate({ kind: go.gate, stage: stage.id }); break; }
      const generation = started.generation ?? 0, tries = started.stages[stage.id].tries;
      if (go.fresh) feed(app, { from: stage.id, kind: "start", code: tries > 1 ? "start.again" : "start", text: `${stage.role} started${tries > 1 ? ` (try ${tries})` : ""}.` });
      const result = go.result ? normalize(go.result) : await runStage(sys, app, stage, generation, go.batch);
      const ended = new Date().toISOString();
      // Work that a stop or a "run again" has made obsolete is not accepted.
      const now = load(app);
      if (result.status === "stopped" || now.stopRequested || (now.generation ?? 0) !== generation) {
        change(app, s => { if ((s.generation ?? 0) === generation) { s.stages[stage.id].status = "pending"; s.status = "stopped"; } }, `${stage.id}: stopped`);
        break;
      }
      if (result.status === "blocked") {
        change(app, s => {
          Object.assign(s.stages[stage.id], { status: "blocked", error: result.summary, summary: result.summary, endedAt: ended });
          if (result.replicaSteps) s.stages[stage.id].replica = { version: result.replicaVersion ?? null, at: ended, steps: result.replicaSteps };
        });
        gate({ kind: "blocked", stage: stage.id });
        break;
      }
      if (result.status !== "done") {
        feed(app, { from: stage.id, kind: "fail", text: result.summary });
        // A test that failed on defects in the app is not a dead end: the developer gets the list
        // and both stages run again, a limited number of times.
        const defects = stage.id === "test" && Array.isArray(result.defects) ? result.defects.map(String).filter(Boolean).slice(0, 20) : [];
        if (defects.length && (now.loops ?? 0) < settings(sys).loops) {
          const loop = (now.loops ?? 0) + 1;
          const build = stageOf("build");
          mkdirSync(join(app.dir, "pipeline", "build"), { recursive: true });
          writeFileSync(join(app.dir, fixesFile(build)), `# Developer: defects the tester found (loop ${loop})\n\nThe full report is in pipeline/test/report.md.\n\n${defects.map(d => `- ${d}`).join("\n")}\n`);
          let obsolete = false;
          change(app, s => {
            if ((s.generation ?? 0) !== generation || s.stopRequested) { obsolete = true; return; }
            s.loops = loop; s.stage = "build";
            s.stages.build = { status: "pending", tries: 0 };
            s.stages.test = { status: "pending", tries: 0, summary: result.summary, ...(result.replicaSteps ? { replica: { version: result.replicaVersion ?? null, at: ended, steps: result.replicaSteps } } : {}) };
          }, `test: ${defects.length} defect(s) sent back to build (loop ${loop})`);
          if (obsolete) { change(app, s => { if (s.stopRequested) s.status = "stopped"; }); break; }
          feed(app, { from: "test", to: "build", kind: "handoff", code: "loop.build", arg: String(defects.length), text: `${defects.length} defect(s) to fix, then I test again (loop ${loop}).` });
          continue;
        }
        const again = tries <= settings(sys).retries;
        change(app, s => {
          Object.assign(s.stages[stage.id], { status: again ? "pending" : "failed", error: result.summary, summary: result.summary, endedAt: ended });
          if (result.replicaSteps) s.stages[stage.id].replica = { version: result.replicaVersion ?? null, at: ended, steps: result.replicaSteps };
          if (!again) s.status = "failed";
        }, `${stage.id}: failed${again ? ", trying again" : ""} (${result.summary})`);
        if (again) continue;
        break;
      }
      const options = stage.gate === "pick" ? preview(sys, app, started, stage, result.options ?? []) : null;
      if (options && !options.length) {
        change(app, s => { Object.assign(s.stages[stage.id], { status: "failed", error: "the stage offered no options", endedAt: ended }); s.status = "failed"; }, `${stage.id}: failed (no options)`);
        break;
      }
      // The tests passed on the source as it is now: remember it, so a later change is noticed before the upload.
      if (now.replica && stage.id === "test") replica.markVerified(app.dir, ended);
      // Whether to ask is decided by the mode as it is when the result is recorded.
      let ask = false, picked = null, obsolete = false;
      change(app, s => {
        if ((s.generation ?? 0) !== generation || s.stopRequested) { obsolete = true; return; }
        ask = Boolean(options) && s.mode === "review";
        picked = options && !ask ? options.find(o => o.id === autoPick(options)) : null;
        Object.assign(s.stages[stage.id], { status: ask ? "waiting" : "done", summary: result.summary, endedAt: ended });
        // An existing project keeps the engine and the application id it was found with.
        for (const field of ["engine", "package", "title"]) if (typeof result[field] === "string" && result[field] && !s.existing?.[field]) s[field] = result[field];
        if (result.replicaSteps) {
          s.stages[stage.id].replica = { version: result.replicaVersion ?? null, at: ended, steps: result.replicaSteps };
          const uploaded = stage.id === "internal" ? result.replicaSteps.map(x => x.versionCode).find(Boolean) : null;
          if (uploaded) s.replicaRelease = { versionCode: uploaded, package: s.package ?? null };
        }
        if (options) s.options = { ...(s.options ?? {}), [stage.id]: options };
        if (picked) s.choice = { ...(s.choice ?? {}), [stage.id]: picked.id };
      }, `${stage.id}: result recorded`);
      if (obsolete) { change(app, s => { if (s.stopRequested) s.status = "stopped"; }); break; }
      if (ask) { gate({ kind: "pick", stage: stage.id }); break; }
      if (picked) feed(app, { from: stage.id, kind: "choice", code: "pick.auto", arg: picked.title, text: `Chose "${picked.title}" (unattended).` });
      feed(app, { from: stage.id, to: next?.id ?? null, kind: "handoff", text: result.summary });
      if (until === stage.id) { change(app, s => { s.status = "paused"; }, `paused after ${stage.id}`); break; }
    }
  } finally {
    release();
  }
  return change(app, s => { s.runner = null; });
}

// ---------------------------------------------------------------- commands

const readText = file => { try { return readFileSync(file, "utf8"); } catch { return null; } };

/** What an existing project folder already is: { engine, package } for Flutter, Godot and Unity; { other } for a
 *  stack this pipeline does not build; null for an empty or new folder. */
export function projectStack(dir) {
  const has = path => existsSync(join(dir, path));
  const engine = /^\s*flutter:\s*$|sdk:\s*flutter/m.test(readText(join(dir, "pubspec.yaml")) ?? "") ? "flutter"
    : has("project.godot") ? "godot" : has(join("ProjectSettings", "ProjectVersion.txt")) ? "unity" : null;
  if (!engine) {
    const other = has("package.json") ? "a JavaScript project (package.json): web, Expo or React Native"
      : has("build.gradle.kts") || has("build.gradle") ? "a native Android project (Gradle)" : null;
    return other ? { other } : null;
  }
  // The application id it already ships with, so a published app is updated, never released under a new id.
  const id = ["android/app/build.gradle.kts", "android/app/build.gradle"].map(f => /applicationId\s*=?\s*["']([\w.]+)["']/.exec(readText(join(dir, f)) ?? "")?.[1]).find(Boolean)
    ?? /package\/unique_name\s*=\s*"([\w.]+)"/.exec(readText(join(dir, "export_presets.cfg")) ?? "")?.[1]
    ?? /applicationIdentifier:[\s\S]*?Android:\s*([\w.]+)/.exec(readText(join(dir, "ProjectSettings", "ProjectSettings.asset")) ?? "")?.[1] ?? null;
  return { engine, package: id };
}

function create(sys, name, flags) {
  if (!name) throw new UsageError('new needs a name: nv-pipeline new "Cat Cafe" --idea "..."');
  const kind = flags.kind ?? "auto", mode = flags.mode ?? "promote";
  if (!["app", "game", "auto"].includes(kind)) throw new UsageError("--kind is app, game or auto");
  if (!MODES.includes(mode)) throw new UsageError(`--mode is one of ${MODES.join(", ")}`);
  const cast = castFlags(flags);
  // Choosing the id and adding it to the list is one step, so two apps made at once both stay listed.
  return locked(join(sys.home, "apps.lock"), () => {
    const apps = registry(sys);
    let id = slug(name);
    for (let n = 2; apps.some(a => a.id === id); n++) id = `${slug(name)}-${n}`;
    const dir = resolve(flags.dir ? flags.dir.replace(/^~(?=$|[\\/])/, homedir()) : join(settings(sys).root, id));
    if (existsSync(stateFile(dir))) throw new UsageError(`${dir} already has a pipeline`);
    const stack = projectStack(dir);
    if (stack?.other) throw new UsageError(`${dir} is ${stack.other}. The Auto app builds Android apps with Flutter, Godot or Unity: give an empty folder, or a Flutter, Godot or Unity project.`);
    const state = {
      id, tag: shortTag(id, apps.map(a => readJson(stateFile(a.dir), {}).tag).filter(Boolean)), generation: 0, name, idea: flags.idea ?? "", refs: (flags.ref ?? []).map((r, i) => reference(r, dir, i)), kind, mode, engine: stack?.engine ?? null,
      ...(stack ? { package: stack.package, existing: { engine: stack.engine, package: stack.package } } : {}), status: "idle", stage: STAGES[0].id, gate: null,
      stages: Object.fromEntries(STAGES.map(s => [s.id, { status: "pending", tries: 0 }])), options: {}, choice: {}, approved: {}, cast, loops: 0, replica: Boolean(flags.replica),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [{ at: new Date().toISOString(), text: "created" }],
      ...(flags.request ? { request: flags.request } : {}),   // a remote caller's requestId and content fingerprint (nv-remote.mjs)
    };
    writeJson(stateFile(dir), state);
    feed({ dir }, { from: "person", to: "research", kind: "note", text: flags.idea ? `Idea: ${flags.idea}` : "Find something worth building." });
    writeJson(registryFile(sys), [...apps, { id, name, dir }]);
    return state;
  });
}

/** A request from a bot or another caller (nv-remote.mjs): create, get or resume an app by requestId. */
function remote(sys, text) {
  let input;
  if (text !== undefined) { try { input = JSON.parse(text); } catch { throw new RemoteError("invalid_params", "the request must be JSON"); } }
  const result = remoteRequest(input, {
    modes: MODES,
    apps: () => registry(sys).map(app => ({ app, state: readJson(stateFile(app.dir), null) })).filter(x => x.state),
    create: (c, request) => {
      const state = create(sys, c.name, { idea: c.idea, kind: c.kind, mode: c.mode, ...(c.dir ? { dir: c.dir } : {}), ref: c.refs, replica: c.replica, request });
      return { app: appOf(sys, state.id), state };
    },
    start: (app, state) => startConductor(sys, app, state),
    conducted: app => Boolean(conductor(app)),
    locked: fn => locked(join(sys.home, "remote.lock"), fn),
  });
  return typeof result === "string" ? { help: result } : result;
}

/** The conductor in its own hc terminal, named as the board names it, so the board shows it working. */
function startConductor(sys, app, state) {
  const name = `pipe-${state.tag ?? app.id.slice(0, 20)}`;
  sys.hc(["rm", name]);   // a finished one left behind
  const r = sys.hc(["run", "--bg", "--json", "--no-notify", "--no-parent", "--rm", "--name", name, "--cwd", app.dir, "--", ...viaShell(["node", join(sys.here, "nv-pipeline.mjs"), "run", app.id], sys.platform)]);
  if (r.code !== 0) throw new Error(`could not start the conductor: ${(r.stderr || r.stdout).trim()}`);
}

/** --cast research=grok:grok-4.7*2 and --review build=codex|none, as the app's own cast. */
function castFlags(flags) {
  const cast = {};
  const each = (list, name, fn) => {
    for (const spec of list ?? []) {
      const at = String(spec).indexOf("="), stage = at < 0 ? "" : spec.slice(0, at).trim(), value = at < 0 ? "" : spec.slice(at + 1).trim();
      if (!stageOf(stage) || !value) throw new UsageError(`--${name} takes <stage>=<agent>, with a stage of: ${STAGES.map(s => s.id).join(", ")}`);
      cast[stage] = { ...(cast[stage] ?? {}), ...fn(value) };
    }
  };
  each(flags.cast, "cast", value => parseCast(value));
  each(flags.review, "review", value => ({ review: value === "none" ? "none" : (parseCast(value), value) }));
  return cast;
}

/** Changes who works on a stage that has not started yet. */
function recast(sys, id, stageId, spec, flags) {
  if (!stageOf(stageId)) throw new UsageError(`unknown stage ${stageId} (nv-pipeline stages)`);
  const review = flags.review?.[0];
  if (!spec && !review) throw new UsageError("cast needs an agent: nv-pipeline cast <id> <stage> claude:opus [--review codex|none]");
  const own = { ...(spec ? parseCast(spec) : {}), ...(review ? { review: review === "none" ? "none" : (parseCast(review), review) } : {}) };
  return change(appOf(sys, id), s => {
    if (s.stages[stageId].status !== "pending") throw new UsageError(`${stageId} has already started; its cast can be changed after "run again"`);
    const merged = { ...(s.cast?.[stageId] ?? {}), ...own };
    if (spec && !own.model) delete merged.model;   // a new agent does not keep the old one's model
    s.cast = { ...(s.cast ?? {}), [stageId]: merged };
  }, `${stageId}: cast ${spec ?? ""}${review ? ` review ${review}` : ""}`.trim());
}

function pick(sys, id, option) {
  const app = appOf(sys, id);
  let chosen;
  const state = change(app, s => {
    const stage = s.gate?.kind === "pick" ? s.gate.stage : STAGES.find(x => x.gate === "pick" && s.stages[x.id].status === "waiting")?.id;
    if (!stage) throw new UsageError(`${id} is not waiting for a choice`);
    const options = s.options?.[stage] ?? [];
    chosen = options.find(o => o.id === option);
    if (!chosen) throw new UsageError(`choose one of: ${options.map(o => o.id).join(", ")}`);
    s.choice = { ...(s.choice ?? {}), [stage]: option };
    s.stages[stage].status = "done";
    s.gate = null; s.status = "idle";
    chosen = { ...chosen, stage, summary: s.stages[stage].summary ?? "" };
  }, `the person chose ${option}`);
  feed(app, { from: "person", to: chosen.stage, kind: "choice", code: "pick.person", arg: chosen.title, text: `Go with "${chosen.title}".` });
  feed(app, { from: chosen.stage, to: STAGES[STAGES.findIndex(x => x.id === chosen.stage) + 1]?.id ?? null, kind: "handoff", text: chosen.summary });
  return state;
}

function approve(sys, id) {
  const app = appOf(sys, id);
  let stage;
  const state = change(app, s => {
    stage = s.gate?.stage ?? "release";
    s.approved = { ...(s.approved ?? {}), [stage]: true };
    if (s.gate?.kind === "approve") { s.gate = null; s.status = "idle"; }
  }, "approved by the person");
  feed(app, { from: "person", to: stage, kind: "choice", code: "approve", text: "Approved. Ship it." });
  return state;
}

function setMode(sys, id, mode) {
  if (!MODES.includes(mode)) throw new UsageError(`mode is one of ${MODES.join(", ")}`);
  return change(appOf(sys, id), s => { s.mode = mode; }, `mode: ${mode}`);
}

/** A note from the person: shown in the feed and typed to the agent working now, if any. */
function say(sys, id, text) {
  if (!text) throw new UsageError("say needs the message");
  const app = appOf(sys, id), state = load(app);
  const stage = stageOf(state.stage);
  const terminals = stage ? terminalsOf(state.stages[stage.id]) : [];
  feed(app, { from: "person", to: stage?.id ?? null, kind: "note", text });
  if (!terminals.length) return { delivered: false, note: "nobody is working now: the note is in the feed for the next stage" };
  const sent = terminals.map(t => sys.hc(["send", t, `Note from the person (follow it within your stage): ${text}`]));
  const bad = sent.find(r => r.code !== 0);
  return { delivered: !bad, to: terminals.join(", "), ...(bad ? { error: (bad.stderr || bad.stdout).trim() } : {}) };
}

/** Runs a stage again. A conductor that is working is stopped first and waited for, and the
 *  generation changes, so nothing it was doing is accepted afterwards. */
async function retry(sys, id, stageId) {
  const app = appOf(sys, id);
  if (stageId && !stageOf(stageId)) throw new UsageError(`unknown stage ${stageId} (nv-pipeline stages)`);
  if (conductor(app) && conductor(app) !== process.pid) {
    stop(sys, id);
    for (let i = 0; i < 240 && conductor(app); i++) await sys.sleep(250);
    if (conductor(app)) throw new UsageError(`${id} is still running; stop it and try again`);
  }
  return change(app, s => {
    const stage = stageId ? stageOf(stageId) : STAGES.find(x => ["failed", "blocked"].includes(s.stages[x.id].status)) ?? stageOf(s.stage) ?? STAGES[0];
    // A stage that is run again invalidates everything built on it.
    let after = false;
    for (const x of STAGES) {
      if (x.id === stage.id) after = true;
      if (!after) continue;
      for (const t of terminalsOf(s.stages[x.id])) endTerminal(sys, t);
      s.stages[x.id] = { status: "pending", tries: 0 };
      rmSync(join(app.dir, fixesFile(x)), { force: true });
      for (const bag of [s.choice, s.options, s.approved]) if (bag) delete bag[x.id];
    }
    s.generation = (s.generation ?? 0) + 1;
    s.status = "idle"; s.gate = null; s.stage = stage.id; s.stopRequested = false; s.loops = 0;
  }, `${stageId ?? "the failed stage"}: will run again`);
}

/** Ends every agent of the pipeline and tells a running conductor to stop. Starting a stage and
 *  this are both done under the state lock, so a stage either has not started, or its terminal is
 *  on record here and is ended. */
function stop(sys, id) {
  const app = appOf(sys, id);
  return change(app, s => {
    for (const x of STAGES) {
      const r = s.stages[x.id];
      for (const t of terminalsOf(r)) endTerminal(sys, t);
      r.terminal = null;
      for (const m of r.members ?? []) m.terminal = null;
      if (["running", "blocked"].includes(r.status)) r.status = "pending";
    }
    if (s.runner && s.runner !== sys.self) sys.hc(["kill", s.runner]);
    s.generation = (s.generation ?? 0) + 1;
    s.stopRequested = true; s.status = "stopped"; s.gate = null; s.runner = null;
  }, "stopped by the person");
}

function remove(sys, id) {
  stop(sys, id);   // whatever its state, no agent of it is left behind
  locked(join(sys.home, "apps.lock"), () => writeJson(registryFile(sys), registry(sys).filter(a => a.id !== id)));
  rmSync(join(sys.home, "preview", id), { recursive: true, force: true });
  return { removed: id, kept: "the project folder and its pipeline/ files" };
}

/** The last lines of the feed, oldest first. */
export function readFeed(dir, limit = 40) {
  if (!existsSync(feedFile(dir))) return [];
  return readFileSync(feedFile(dir), "utf8").trimEnd().split("\n").slice(-limit).map(readJsonText).filter(e => e && typeof e.text === "string");
}

/** What is really happening in a stage the state file calls "running":
 *  working (an agent says so, or says nothing), quiet (its agents report idle, done or an error and
 *  the conductor is reminding them) or stalled (no conductor is alive, or its terminals are gone). */
export function activityOf(rec, terminals, conducted) {
  if (rec?.status !== "running") return null;
  if (!conducted) return "stalled";
  if (!terminals) return "working";            // the terminal list could not be read: say nothing worse
  const mine = terminalsOf(rec);
  if (!mine.length) return "working";          // between two steps
  const live = mine.map(t => terminals.get(t)).filter(t => t && t.state !== "finished");
  if (!live.length) return "stalled";
  return live.some(t => !["idle", "done", "error"].includes(statusWord(t))) ? "working" : "quiet";
}

function status(sys, id) {
  const listed = readJsonText(sys.hc(["ls", "--json"]).stdout)?.terminals;
  const terminals = Array.isArray(listed) ? new Map(listed.flatMap(t => [[t.address, t], [t.name, t]].filter(([k]) => k))) : null;
  const apps = registry(sys).filter(a => !id || a.id === id).map(a => {
    const state = readJson(stateFile(a.dir), null);
    if (!state) return { ...a, state, feed: readFeed(a.dir) };
    const conducted = Boolean(conductor(a));
    // The app's own team, so the board shows who will do each stage, with which model and how many.
    const team = Object.fromEntries(STAGES.map(s => {
      const c = castFor(sys, state, s.id), agent = agentFor(sys, s.id, 1, c.want);
      return [s.id, { agent: agent.name, model: agent.model, count: c.count, review: c.reviewer ? `${c.reviewer.agent}${c.reviewer.model ? `:${c.reviewer.model}` : ""}` : "none" }];
    }));
    const activity = Object.fromEntries(STAGES.map(s => [s.id, activityOf(state.stages?.[s.id], terminals, conducted)]).filter(([, v]) => v));
    const live = Object.fromEntries(STAGES.flatMap(s => terminalsOf(state.stages?.[s.id]).map(t => [t, terminals?.get(t) ? statusWord(terminals.get(t)) ?? "live" : terminals ? "gone" : "unknown"])));
    // With Replica: every skill step of every stage, its files and what the conductor found.
    return { ...a, state, feed: readFeed(a.dir), conducted, team, activity, live, ...(state.replica ? { replica: replica.overview(a.dir, state) } : {}) };
  });
  // Who would take each stage now, so the board can show the model at every desk before it starts.
  const cast = Object.fromEntries(STAGES.map(s => [s.id, agentFor(sys, s.id).name]));
  const pack = replica.bundleOf(sys);
  return { key: keyStatus(sys), root: settings(sys).root, stages: STAGES.map(s => ({ ...s, agent: cast[s.id] })), apps, replica: { installed: Boolean(pack), version: replica.versionOf(pack)?.short ?? null } };
}

export function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--refresh") flags.refresh = true;
    else if (a === "--replica") flags.replica = true;
    else if (a === "--ref") {
      if (i + 1 >= argv.length) throw new UsageError("--ref needs a link or an image file");
      (flags.ref ??= []).push(argv[++i]);
    } else if (a === "--cast" || a === "--review") {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs <stage>=<agent>`);
      (flags[a.slice(2)] ??= []).push(argv[++i]);
    } else if (["--idea", "--kind", "--mode", "--dir", "--until"].includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  return { command: rest[0] ?? "help", args: rest.slice(1), flags };
}

export async function main(sys, { command, args, flags }) {
  switch (command) {
    case "new": return create(sys, args.join(" "), flags);
    case "run": {
      if (flags.until && !stageOf(flags.until)) throw new UsageError(`--until takes a stage: ${STAGES.map(s => s.id).join(", ")}`);
      return advance(sys, need(args, "run"), { until: flags.until });
    }
    case "pick": if (!args[1]) throw new UsageError("pick needs an option id"); return pick(sys, need(args, "pick"), args[1]);
    case "approve": return approve(sys, need(args, "approve"));
    case "mode": return setMode(sys, need(args, "mode"), args[1]);
    case "cast": return recast(sys, need(args, "cast"), args[1], args[2], flags);
    case "agents": return args[0] === "add" ? addAgent(sys, args[1], args.slice(2)) : agentList(sys, Boolean(flags.refresh));
    case "say": return say(sys, need(args, "say"), args.slice(1).join(" "));
    case "retry": return retry(sys, need(args, "retry"), args[1]);
    case "stop": return stop(sys, need(args, "stop"));
    case "remove": return remove(sys, need(args, "remove"));
    case "status": return status(sys, args[0]);
    case "stages": return { stages: STAGES };
    case "remote": return remote(sys, args[0]);
    case "replica": return { ...replica.doctor(sys), skills: replica.SKILLS.map(s => s.id), stages: Object.fromEntries(STAGES.map(s => [s.id, (replica.PLAN[s.id] ?? []).filter(x => x.skill).map(x => `${x.skill}${x.part ? ` (${x.part})` : ""}`)])) };
    case "key":
      if (args[0] === "set") { if (!args[1]) throw new UsageError("key set needs the path of the service account JSON"); return { saved: true, ...setKey(sys, resolve(args[1])) }; }
      return keyStatus(sys);
    case "help": case "--help": case "-h":
      return { help: readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 28).map(l => l.replace(/^\/\/ ?/, "")).join("\n") };
    default: throw new UsageError(`unknown command: ${command} (nv-pipeline help)`);
  }
}
const need = (args, command) => { if (!args[0]) throw new UsageError(`${command} needs a pipeline id (nv-pipeline status)`); return args[0]; };

function print(command, result, json) {
  if (json) return console.log(JSON.stringify(result));
  if (result.help) return console.log(result.help);
  if (command === "replica") {
    console.log(`Replica skill pack: ${result.bundle ?? "not installed"}${result.version ? `  commit ${result.version.short} (${result.version.date}, ${result.version.license})  ${result.version.url}` : ""}`);
    console.log(`Python: ${result.python ?? "not found"}`);
    for (const m of result.missing) console.log(`missing: ${m}`);
    console.log(`\nThe pack's own order: ${result.skills.map(s => s.replace("replica-", "")).join(" → ")}\n\nIn this pipeline:`);
    for (const [stage, skills] of Object.entries(result.stages)) console.log(`  ${stage.padEnd(9)} ${skills.join(", ") || "(uses the files the skills left; no skill of its own)"}`);
    return;
  }
  if (command === "remote") return console.log(JSON.stringify(result, null, 2));
  if (command === "stages") return console.log(result.stages.map(s => `${s.id.padEnd(9)} ${s.role.padEnd(16)} ${String(s.minutes).padStart(3)} min  ${s.about}`).join("\n"));
  if (command === "status") {
    console.log(`Play key: ${result.key.present ? result.key.email : "not set (nv-pipeline key set <file>)"}`);
    for (const a of result.apps) {
      const s = a.state;
      if (!s) { console.log(`${a.id}  (state unreadable: ${a.dir})`); continue; }
      console.log(`${a.id}  ${s.status}${s.gate ? ` · needs you: ${s.gate.kind} at ${s.gate.stage}` : ""}  mode ${s.mode}  ${s.engine ?? ""}  ${a.dir}`);
      console.log("  " + STAGES.map(st => `${st.id}:${s.stages[st.id].status}`).join("  "));
    }
    return;
  }
  if (result.id && result.stages) return console.log(`${result.id}: ${result.status}${result.gate ? ` (needs you: ${result.gate.kind} at ${result.gate.stage})` : ""}`);
  console.log(Object.entries(result).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("  "));
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (invoked) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    print(parsed.command, await main(realSystem(), parsed), parsed.flags.json);
    process.exit(0);
  } catch (error) {
    const msg = String(error?.message ?? error);
    if (parsed?.flags.json) console.error(JSON.stringify({ error: msg })); else console.error(`nv-pipeline: ${msg}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
