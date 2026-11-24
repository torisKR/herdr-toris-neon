// One tool as a list in the left sidebar, beside Spaces and Agents: the layout gives each block
// {section: "today" | "play" | "pipeline" | "bots"}. It reads what that tool's own script answers (no tokens,
// Play check only its last saved answer), on this computer and, like the tool's tab, on connected machines
// (Auto app is this computer only, as its tab), and opens the tool's tab, reusing the one already showing it.
// Bots (nv-bot, this computer only) have no tab: a running bot's row shows its terminal.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { appHome, checking, exec, layout, machines, panes, props, readTextFile, run, settings, setShared, shared, spaces, theme } from "herdr";

const POLL_MS = 30000;
const PLAY_STATES = {
  en: { live: "Published", review: "In review", rejected: "Rejected", ready: "Approved", draft: "Draft", testing: "Testing only", none: "No release", other: "Production" },
  ko: { live: "출시됨", review: "검토 중", rejected: "반려됨", ready: "게시 대기", draft: "초안", testing: "테스트만", none: "출시 없음", other: "프로덕션" },
};
const BOT_STATES = {
  en: { working: "working", blocked: "needs you", idle: "ready", done: "ready", live: "on", off: "off" },
  ko: { working: "작업 중", blocked: "확인 필요", idle: "대기", done: "대기", live: "켜짐", off: "꺼짐" },
};
const TEXT = {
  en: { today: "Today", play: "Play check", pipeline: "Auto app", bots: "Bots", empty: "Nothing yet", noBots: "Type @@autoapp <idea> in Claude or Codex", loading: "Reading…", search: "Search apps", none: "No match", states: PLAY_STATES.en, bot: BOT_STATES.en },
  ko: { today: "오늘 · 이어하기", play: "Play 체크", pipeline: "Auto app", bots: "Bots", empty: "아직 없음", noBots: "Claude·Codex에서 @@autoapp <아이디어>", loading: "읽는 중…", search: "앱 검색", none: "검색 결과 없음", states: PLAY_STATES.ko, bot: BOT_STATES.ko },
  ja: { today: "今日", play: "Play チェック", pipeline: "Auto app", bots: "Bots", empty: "まだありません", noBots: "Type @@autoapp <idea> in Claude or Codex", loading: "読み込み中…", search: "アプリを検索", none: "一致なし", states: PLAY_STATES.en, bot: BOT_STATES.en },
  zh: { today: "今天", play: "Play 检查", pipeline: "Auto app", bots: "Bots", empty: "暂无", noBots: "Type @@autoapp <idea> in Claude or Codex", loading: "读取中…", search: "搜索应用", none: "无匹配", states: PLAY_STATES.en, bot: BOT_STATES.en },
};
const language = value => {
  const key = String(value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(TEXT, key) ? key : null;
};
const copy = () => TEXT[language(shared("nv.language")) ?? language(settings().language) ?? language(settings().locale) ?? "en"];

/** What each section reads, which tab it opens, and its rows: { id, name, search?, app?, color(t), hint(l) }. */
const SECTIONS = {
  today: { tool: "nv-today", command: "list", remote: true, mod: "nv-today", tab: "Today",
    rows: d => (d.projects ?? []).map(p => ({ id: p.id, name: p.name,
      color: t => p.focus === "main" ? t.accent : p.focus === "maint" ? t.working : t.dim, hint: () => p.focus === "main" ? "★" : p.focus === "maint" ? "•" : "" })) },
  play: { tool: "nv-play", command: "list", remote: true, mod: "nv-play", tab: "Play check", searchable: true,
    rows: d => (d.accounts ?? []).flatMap(a => a.apps ?? []).map(a => ({ id: a.package, name: a.name, search: `${a.name} ${a.package}`.toLowerCase(),
      color: t => a.state === "rejected" ? t.blocked : a.state === "review" ? t.working : a.state === "live" || a.state === "ready" ? t.done : t.dim,
      hint: l => l.states[a.state] ?? "" })) },
  pipeline: { tool: "nv-pipeline", command: "status", mod: "nv-pipeline", tab: "Auto app", create: { create: true },
    rows: d => (d.apps ?? []).filter(a => a.state).map(a => ({ id: a.id, name: a.state.name ?? a.id, app: a.id,
      color: t => ({ waiting: t.blocked, failed: t.blocked, running: t.working, done: t.done })[a.state.status] ?? t.idle, hint: () => a.state.stage ?? "" })) },
  bots: { tool: "nv-bot", command: "ls", empty: "noBots",
    rows: d => (d.bots ?? []).map(b => ({ id: b.name, name: `@@${b.name}`, terminal: b.status ? b.terminal : null,
      color: t => ({ working: t.working, blocked: t.blocked, idle: t.done, done: t.done })[b.status] ?? (b.status ? t.idle : t.dim),
      hint: l => l.bot[b.status ?? "off"] ?? b.status })) },
};

const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).map(c => findNode(c, id)).find(Boolean) ?? null;
// Same rule as the spaces list: under 160px the sidebar is a rail of icons.
const narrow = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class SidebarSection extends View {
  init(_props, cx) {
    this.key = Object.hasOwn(SECTIONS, props()?.section) ? props().section : "today";
    this.rows = null;
    this.error = null;
    this.search = InputState.new({ placeholder: copy().search });
    this.search.on("change", (_e, cx) => cx.notify());
    if (checking()) return;
    cx.timer.every(POLL_MS, cx => this.load(cx));
    this.load(cx);
  }

  load(cx) {
    if (this.loading) return;
    const s = SECTIONS[this.key];
    this.loading = true;
    cx.spawn(async cx => {
      const names = s.remote ? [...new Set([null, ...machines().filter(m => m.name && m.layout !== "unavailable").map(m => m.name)])] : [null];
      const answers = await Promise.all(names.map(async machine => {
        try { return { rows: s.rows(await this.read(s, machine)).map(r => ({ ...r, id: machine ? `${machine}/${r.id}` : r.id })) }; }
        // A machine without Node or without this pack is left out quietly; this computer says why.
        catch (error) { return { rows: [], error: machine ? null : String(error?.message ?? error) }; }
      }));
      // One row per id: an app two Play accounts can see is listed once.
      const seen = new Set();
      this.rows = answers.flatMap(a => a.rows).filter(r => !seen.has(r.id) && seen.add(r.id));
      this.error = answers.find(a => a.error)?.error ?? null;
      this.loading = false;
      cx.notify();
    });
  }

  /** What the tool answers on a machine (null: this computer). Today and Play run their script's source there,
   *  as their tabs do, so a machine without this pack still answers; Auto app runs the local conductor. */
  async read(s, machine) {
    let r;
    if (!s.remote) r = await exec("node", [`${appHome()}/bin/${s.tool}.mjs`, s.command, "--json"], { timeout: 30000 });
    else {
      this.source ??= await readTextFile(`${appHome()}/bin/${s.tool}.mjs`);
      if (!this.source) throw new Error(`bin/${s.tool}.mjs is missing: install this pack again`);
      const request = JSON.stringify({ command: s.command, args: [], flags: {} });
      const script = `${this.source}\nPromise.resolve().then(() => run(${request})).then(r => r, e => ({ error: String(e && e.message || e) })).then(r => { console.log(JSON.stringify(r)); process.exit(0); });`;
      r = await exec("node", ["--input-type=module", "-e", script], { on: machine, timeout: 60000 });
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "node failed").trim().slice(0, 200));
    const data = JSON.parse(r.stdout);
    if (data.error) throw new Error(data.error);
    return data;
  }

  /** Shows the tab of the shown space that has this tool open (by its mod: tab names are the person's), else opens one. */
  open(extra = null) {
    const s = SECTIONS[this.key], space = spaces().find(x => x.active);
    if (!space || !s.mod) return;
    const ids = new Set(space.tabs.map(c => c.id));
    const tab = extra ? null : panes().find(p => p.mod === s.mod && ids.has(p.tab))?.tab;
    if (tab) run("tab.select", { id: tab });
    else run("tab.new", { name: s.tab, space: space.id, mod: s.mod, ...(extra && { props: extra }) });
  }

  pick(row) {
    if (row.terminal) return run("terminal.peek", { terminal: row.terminal });   // a running bot
    if (!SECTIONS[this.key].mod) return;
    if (row.app) {
      // n counts every pick, so an open pipeline tab takes even a pick of the app it already shows.
      setShared("nv.pipeline.app", row.app);
      setShared("nv.pipeline.pick", { id: row.app, n: (shared("nv.pipeline.pick")?.n ?? 0) + 1 });
    }
    this.open();
  }

  render() {
    const t = theme(), l = copy(), s = SECTIONS[this.key], rail = narrow();
    const query = s.searchable ? this.search.value().trim().toLowerCase() : "";
    const rows = (this.rows ?? []).filter(r => !query || r.search.includes(query));
    const note = this.error ?? (this.rows === null ? l.loading : !this.rows.length ? l[s.empty ?? "empty"] : !rows.length ? l.none : null);
    const header = h_flex().h(31).pl(rail ? 0 : 16).pr(rail ? 0 : 10).items_center().justify_between().text_size(11.5).text_color(t.dim)
      .when(rail, el => el.justify_center())
      .child(div().id("section-title").cursor_pointer().hover(st => st.text_color(t.foreground)).on_click(() => this.open())
        .child(rail ? div().h(1).w(20).bg(t.border) : l[this.key]))
      .when(Boolean(s.create) && !rail, el => el.child(div().id("section-new").size(26).flex_none().flex().items_center().justify_center()
        .rounded(6).hover(st => st.bg(t.hover).text_color(t.foreground)).on_click(() => this.open(s.create)).child("+")));
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t_1().border_color(t.border).text_size(13)
      .child(header)
      .when(s.searchable && !rail, el => el.child(h_flex().id("section-search").mx(8).mb(4).h(26).px(8).rounded(6).bg(t.raised).items_center()
        .child(Input.new(this.search).w_full().h_full().text_size(12).text_color(t.foreground))))
      .child(v_flex().flex_1().min_h(0).px(rail ? 0 : 8).pb(8).overflow_y_scrollbar()
        .children(rows.map(r => h_flex().id(`row-${r.id}`).h(28).flex_none().px(rail ? 0 : 8).gap(8).rounded(7).items_center().cursor_pointer()
          .when(rail, el => el.justify_center()).hover(st => st.bg(t.hover)).on_click(() => this.pick(r))
          .child(div().w(7).h(7).flex_none().rounded_full().bg(r.color(t)))
          .when(!rail, el => el.child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.name))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(r.hint(l))))))
        .when(Boolean(note) && !rail, el => el.child(div().px(8).py(4).text_size(11.5).text_color(this.error ? t.blocked : t.dim).child(note))));
  }
}
