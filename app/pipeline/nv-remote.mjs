// Remote control of the Auto app for bots and other callers, ported from orca-toris-neon
// (src/remote.mjs, src/milestones.mjs). A caller's requestId names one request: the same requestId
// with the same content returns the app it already made (a stopped one too, so a redelivered message
// never starts work twice), the same requestId with different content is a conflict, and the idea
// text alone never dedupes. The requestId and the content fingerprint are kept in the app's own
// state.json, so they survive restarts without a store of their own.
//   nv-pipeline remote '{"action":"create","requestId":"m-1","name":"Cat Cafe","idea":"..."}'
// create only plans (status idle); resume starts the conductor in its own hc terminal.
import { createHash } from "node:crypto";

const REQUEST_ID = /^[\w.:-]{1,70}$/;
const KINDS = ["app", "game", "auto"];
const FIELDS = {
  create: ["action", "requestId", "name", "idea", "kind", "mode", "dir", "refs", "replica"],
  get: ["action", "requestId", "id"],
  resume: ["action", "requestId", "id", "expectedRevision"],
};

export const REMOTE_HELP = [
  "Auto app remote control: nv-pipeline remote '<json>' [--json]",
  '- {"action":"create","requestId","name","idea","kind?":"app|game|auto","mode?":"auto|promote|review","dir?","refs?":[...],"replica?":true}  plan an app (does not start it; mode defaults to promote: asks before production)',
  '- {"action":"get","requestId"|"id"}  status, the gate waiting for a person, and what actually finished (구현·검증·제출)',
  '- {"action":"resume","requestId"|"id","expectedRevision?"}  start the conductor, or continue after pick/approve',
  "The same requestId with the same content returns the existing app; different content is a [conflict]. The idea text alone never dedupes.",
].join("\n");

export class RemoteError extends Error {
  constructor(code, message) { super(`[${code}] ${message}`); this.code = code; }
}
const invalid = message => new RemoteError("invalid_params", message);

const text = (value, label, max, required) => {
  if (value === undefined || value === null) { if (required) throw invalid(`${label} is required`); return null; }
  if (typeof value !== "string" || value.length > max) throw invalid(`${label} must be a string of at most ${max} characters`);
  const trimmed = value.trim();
  if (!trimmed && required) throw invalid(`${label} is required`);
  return trimmed || null;
};
const requestIdOf = value => {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw invalid("requestId must be 1-70 characters of letters, digits and _ . : -");
  return value;
};

/** What a create request asks for, normalized so the same request always has the same fingerprint. */
export function contentOf(input, modes) {
  const kind = text(input.kind, "kind", 10, false) ?? "auto", mode = text(input.mode, "mode", 10, false) ?? "promote";
  if (!KINDS.includes(kind)) throw invalid(`kind is one of ${KINDS.join(", ")}`);
  if (!modes.includes(mode)) throw invalid(`mode is one of ${modes.join(", ")}`);
  if (input.refs !== undefined && (!Array.isArray(input.refs) || input.refs.length > 20 || input.refs.some(r => typeof r !== "string" || r.length > 2000))) throw invalid("refs must be a list of at most 20 links or image paths");
  if (input.replica !== undefined && typeof input.replica !== "boolean") throw invalid("replica must be true or false");
  return { name: text(input.name, "name", 80, true), idea: text(input.idea, "idea", 6000, true), kind, mode,
    dir: text(input.dir, "dir", 1000, false), refs: input.refs ?? [], replica: Boolean(input.replica) };
}
export const fingerprintOf = content => createHash("sha256").update(JSON.stringify([content.name, content.idea, content.kind, content.mode, content.dir, content.refs, content.replica])).digest("hex").slice(0, 16);

const SUBMIT = ["internal", "release"];
/** What an app actually finished: 구현 (build), 검증 (test), 제출 (internal track / production). */
export function milestones(state) {
  const done = id => state?.stages?.[id]?.status === "done";
  const submitted = SUBMIT.filter(done);
  return [
    { id: "implement", label: "구현", state: done("build") ? "done" : "not_done" },
    { id: "verify", label: "검증", state: done("test") ? "done" : "not_done" },
    { id: "submit", label: "제출", state: submitted.length ? "done" : "not_done", detail: submitted.length ? submitted.join(", ") : null },
  ];
}
const WORDS = {
  implement: { done: "구현 완료", not_done: "구현 안 됨" },
  verify: { done: "검증 완료", not_done: "검증 안 됨" },
  submit: { done: "제출 완료", not_done: "제출 안 함" },
};
export const milestoneText = state => milestones(state).map(m => WORDS[m.id][m.state] + (m.detail ? ` (${m.detail})` : "")).join(" · ");

/** What a caller sees of an app: never the fingerprint, always what actually finished. */
export function remoteSummary(app, state, conducted = false) {
  const stages = Object.values(state.stages ?? {});
  return {
    id: app.id, requestId: state.request?.id ?? null, name: state.name, status: state.status, running: Boolean(conducted),
    gate: state.gate ?? null, mode: state.mode, dir: app.dir, stage: state.stage ?? null, revision: state.updatedAt ?? null,
    stages: { done: stages.filter(s => s.status === "done").length, total: stages.length },
    finished: milestones(state), finishedText: milestoneText(state),
  };
}

/**
 * One remote request. deps (from nv-pipeline): apps() → [{ app, state }], create(content, request) → { app, state },
 * start(app) starts the conductor, conducted(app) → is it running now, locked(fn) runs fn alone.
 */
export function remoteRequest(input, deps) {
  if (input === undefined || input === null) return REMOTE_HELP;
  if (typeof input !== "object" || Array.isArray(input)) throw invalid("the request must be a JSON object");
  if (!Object.keys(input).length) return REMOTE_HELP;
  if (!Object.hasOwn(FIELDS, input.action)) throw invalid(`action is one of ${Object.keys(FIELDS).join(", ")}`);
  const extra = Object.keys(input).filter(key => !FIELDS[input.action].includes(key));
  if (extra.length) throw invalid(`unknown fields for ${input.action}: ${extra.join(", ")}`);
  const summary = ({ app, state }) => remoteSummary(app, state, deps.conducted(app));
  if (input.action === "get") return { app: summary(target(input, deps)) };
  return deps.locked(() => input.action === "create" ? create(input, deps, summary) : resume(input, deps, summary));
}

function create(input, deps, summary) {
  const requestId = requestIdOf(input.requestId);
  const content = contentOf(input, deps.modes), fingerprint = fingerprintOf(content);
  const existing = deps.apps().find(({ state }) => state.request?.id === requestId);
  if (existing) {
    if (existing.state.request.fingerprint !== fingerprint) throw new RemoteError("conflict", `requestId ${requestId} already made ${existing.app.id} with different content. Use a new requestId for a new request.`);
    return { created: false, app: summary(existing) };
  }
  return { created: true, app: summary(deps.create(content, { id: requestId, fingerprint })) };
}

function target(input, deps) {
  if ((input.id === undefined) === (input.requestId === undefined)) throw invalid("give exactly one of requestId and id");
  const found = input.id !== undefined
    ? deps.apps().find(({ app }) => app.id === input.id)
    : deps.apps().find(({ state }) => state.request?.id === requestIdOf(input.requestId));
  if (!found) throw new RemoteError("not_found", "no such app (nv-pipeline status)");
  return found;
}

function resume(input, deps, summary) {
  const found = target(input, deps), { app, state } = found;
  if (input.expectedRevision !== undefined && typeof input.expectedRevision !== "string") throw invalid("expectedRevision must be the revision string get returned");
  if (deps.conducted(app)) return { action: "running", app: summary(found) };
  if (state.status === "done") throw new RemoteError("conflict", `${app.id} is already done`);
  if (state.status === "waiting" && state.gate) throw new RemoteError("conflict", `${app.id} waits for the person: ${state.gate.kind} at ${state.gate.stage} (nv-pipeline ${state.gate.kind === "pick" ? "pick <id> <option>" : state.gate.kind === "approve" ? "approve <id>" : "status <id>"}, then resume)`);
  if (state.status === "failed") throw new RemoteError("conflict", `${app.id} failed at ${state.stage}: run "nv-pipeline retry ${app.id}" to try that stage again, then resume`);
  // Best effort: the app may still change between this check and the start.
  if (input.expectedRevision !== undefined && input.expectedRevision !== state.updatedAt) throw new RemoteError("conflict", `${app.id} changed since (revision ${state.updatedAt}); read it again first`);
  deps.start(app, state);
  return { action: state.status === "idle" && !Object.values(state.stages ?? {}).some(s => s.status !== "pending") ? "started" : "resumed", app: summary(found) };
}
