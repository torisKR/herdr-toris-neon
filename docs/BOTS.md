# Bots (@@name)

A bot is a long-lived agent with a name, a purpose and a memory. Start a prompt in Claude Code or Codex with
`@@name` and the request goes to that bot instead of the agent you are typing to:

```
@@autoapp a cozy fishing idle game, like the reference https://play.google.com/store/apps/details?id=…
@@scout why does the Roomdoku login crash on Android 14?
```

- A `UserPromptSubmit` hook (`nv-bot hook`) catches the prompt before the agent sees it and shows where it went.
- The bot runs in its own hc terminal, `bot-<name>`, and stays running between requests. The first request starts it.
- Its answer comes back to the terminal you asked from as an `<hc from="… bot-name">` message.
- The left sidebar has a **Bots** list under Spaces, Agents and the tool lists. A running bot's row opens its terminal.

## Making a bot

```sh
nv-bot new scout --purpose "Finds crashes in the Android apps and says where they come from." [--agent codex] [--cwd <dir>]
nv-bot ls
nv-bot ask scout "why does login crash?"     # the same as @@scout, from a script or another agent
```

(`nv-bot` is `node ~/.config/herdr-app/bin/nv-bot.mjs`.) Each bot is a folder, `~/.config/herdr-app/bots/<name>/`:
`bot.json` (agent and folder), `SOUL.md` (what it is for and what it must never do) and `MEMORY.md` (what it keeps).
Edit the two Markdown files as you like; the bot reads them when it starts.

Every bot starts in `~/.config/herdr-app/bots`. Claude Code asks once whether to trust that folder; answer it in the
first bot's terminal (`hc attach bot-<name>`), and the answer covers every bot after it.

## @@autoapp: the Auto app from a message

`@@autoapp` is built in and made on first use. It turns a request into an Auto app run through the remote contract
ported from orca-toris-neon (`nv-pipeline remote`):

```sh
nv-pipeline remote '{"action":"create","requestId":"m-1","name":"Cat Cafe","idea":"…","kind":"game"}'
nv-pipeline remote '{"action":"resume","requestId":"m-1"}'   # starts the conductor (it shows on the board)
nv-pipeline remote '{"action":"get","requestId":"m-1"}'      # status, the gate waiting for you, 구현 · 검증 · 제출
```

- The same requestId with the same content returns the app it already made. Different content is a `[conflict]`, and
  the idea text alone never counts as the same request. The routed message's id (`m-…`) is the requestId, so a
  repeated message never makes a second app.
- A new app defaults to `promote`, which asks before production. The bot passes picks and the production approval on
  to you and never approves, switches to `auto`, removes or uploads on its own.
- `resume` refuses an app that waits for a pick or an approval, that failed (`retry` first) or that is done.
- Not ported: orca-toris-neon's `improve`/`diagnose` modes and `followUp`. This pipeline has only the new-app flow.

## Hooks

The installers run `nv-bot hooks install`. It appends the hook to `~/.claude/settings.json` and `~/.codex/hooks.json`
(where those agents are set up) and keeps a `.bak-nv-bot` copy. Other hooks keep their place.
`nv-bot hooks status` shows where it is, and `nv-bot hooks remove` takes it out.

- Claude Code: verified. A blocked `@@` prompt shows the routing message and uses no tokens.
- Codex: Codex trusts hooks one by one (`[hooks.state]` in `~/.codex/config.toml`), so it may ask you to trust
  the new hook once. Its blocking behaviour has not been checked yet.

## Other machines

Bots and Auto app runs are kept per machine. Nothing is synced:

| What | Where | Shared between machines? |
|---|---|---|
| Bots | `~/.config/herdr-app/bots` | No |
| Auto app list and runs | `~/.config/herdr-app/pipeline/apps.json`, `<project>/pipeline/state.json` | No (the sidebar already lists Auto app for this computer only) |
| Today, Play check | their own files | Read from connected machines by the sidebar, never copied |

hc can already reach another machine: `hc run --on <machine>`, `hc send <machine>/<terminal>`,
`hc exec --on` and `hc file read|write --on`. So a bot on another machine could be started and messaged from here.
Answers cannot come back yet: that machine's hc does not know this one, so `hc send <this machine>/t9` has no route.
The next steps, if they are wanted:

1. Copy bots: push a bot's folder with `hc file write --on <machine>`, as a manual `nv-bot push`.
2. Remote bots: `@@scout@lefairy` starts or messages `lefairy/bot-scout`, and the answer is read back with `hc read`.
3. A shared registry (one source of truth for bots and runs) needs a server, like Orca Cloud. It is not planned.
