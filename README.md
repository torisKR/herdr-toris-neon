# herdr-toris-neon

**English** · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Français](README.fr.md)

A workspace pack for [Herdr](https://herdr.dev), the desktop app and terminal for AI coding agents. It turns Herdr into a place where a team of agents plans, builds, tests and ships an app while you watch: an app pipeline with a pixel-art team board, a real browser agents can drive, pull requests, devices, usage, and a neon violet look.

![The app pipeline: every teammate at a desk, their chat on the left, design options to pick on the right](docs/pipeline.png)

## What is inside

| Feature | Open it | What it does |
| --- | --- | --- |
| **Auto app** | + menu → Auto app · `Ctrl/Cmd+Shift+Y` | Give it a folder and an idea. A team of agents researches, plans, designs, builds, tests on a device, prepares the store listing and releases through fastlane. |
| **Today** | + menu → Today · `Ctrl/Cmd+Shift+J` | What to pick up now: one main project and one maintenance project, each with the next action, why it stopped, where to continue, and whether what was verified still holds. Details: [Today](docs/TODAY.md). |
| **Play check** | + menu → Play check · `Ctrl/Cmd+Shift+L` | Every app of a Google Play developer account with where it stands: published, in review, rejected, draft or testing only, per track. Read only. Details: [Play check](docs/PLAY.md). |
| **Browser with Inspect** | `Ctrl/Cmd+Shift+U` | A real Chrome/Edge inside Herdr. Agents drive their own tabs; you click an element, say what to change, and send it to an agent. |
| **ALL agents** | `Ctrl/Cmd+Shift+A` | Every running agent's live terminal on one screen. Press again to go back. |
| **Pull requests** | `Ctrl/Cmd+Shift+G` | Read, comment on and merge the repository's pull requests beside your terminal. |
| **Devices** | `Ctrl/Cmd+Shift+D` | adb devices (USB and Wi-Fi), Android emulators and iOS simulators, on this computer and connected ones. |
| **Files, editor, code** | Files · `Ctrl/Cmd+Shift+H` | A file tree with an editor, Markdown/HTML preview and syntax highlighting. |
| **AI usage** | + menu → AI usage | Tokens, cost estimates and limits for Claude and Codex across your machines. |
| **Screenshot paste** | `Ctrl+V` · `Cmd+V` | A screenshot on the clipboard goes to Claude Code or Codex as an image, also into terminals on another machine. |
| **Update** | + menu → Update | Downloads the newest version from GitHub and installs it, with the progress on screen. |
| **Bots** | `@@name` in Claude Code or Codex · sidebar | Long-lived agents with a purpose and a memory. `@@autoapp <idea>` starts an Auto app run. Details: [Bots](docs/BOTS.md). |
| **Agent skill** | installed for Claude Code and Codex | `herdr-hc` teaches agents to orchestrate with `hc`, change the window and use the browser. |
| **Neon violet theme** |  | Colors for the app, the terminal herdr and matching terminal schemes. |

## Auto app: from an idea to the store

- Open **Auto app** from the + menu, choose a project folder, describe what to build, and add references if you have them (Play Store links, repositories, screenshots).
- Nine teammates take turns: Researcher, Planner, Designer, Artist, Developer, Tester, Marketer, Release manager, Publisher. Each is a fresh agent that reads one task and writes one result, so nothing piles up in a conversation.
- Different models do what they are good at: Grok researches, Codex draws, Claude plans, builds and releases. A model that is missing or fails is replaced by Claude.
- Cast the team before it starts: for each role pick any agent CLI installed on the machine, its model, how many work at once, and a reviewer. Work that fails the review or the automatic image checks goes back for another round, and a failed test goes back to the developer.
- Choose how much it asks you: **unattended**, **ask before production** (default), or **ask at every choice**. Ideas and designs appear as cards to click.
- Apps are built with Flutter; games with Godot or Unity + URP depending on the genre. Releases go to the Play internal track first, then production. An existing Flutter, Godot or Unity project keeps its engine and application id; another stack (web, Expo, native Gradle) is refused with the reason.
- References are studied, never copied: the genre and the loop are taken, the name, art and text are new.
- Optional: **Use the Replica skills** (or `--replica`) runs the eleven skills of [The Replica skill](https://github.com/Jakeschincariol/replica-skill) inside the stages: a recon map and feature matrix of the reference, real reviews read before the brief, and parity, leftovers of the reference and the listing checked by the conductor before any upload. Needs Python 3.8+. The pack is included at a pinned commit (MIT); runs without the switch are unchanged.

Details: [App pipeline](docs/PIPELINE.md).

## Browser: look at a page, point, and have it fixed

![The Browser window: the page drawn live, the address bar, and the Inspect panel with running agents](docs/browser-chrome.png)

- On macOS and Linux with the graphical runtime it uses herdr-web-browser; everywhere else, and on Windows, it drives your installed Chrome or Edge with a separate profile.
- Agents use `nv-web`: `open`, `snapshot`, `click`, `type`, `inspect`, `console --errors`, `network --failed`, `css` to try a fix live.
- **Inspect** sends the element you clicked (selector, styles, source file in dev builds, an outlined screenshot) to the agent you choose.

Details: [Browser and document previews](docs/BROWSER.md).

## Agents, pull requests and devices

![ALL agents board](docs/agents.png)

![Devices](docs/devices.png)

## Install

Requires the Herdr desktop app (and/or terminal herdr 0.9.5+), Node.js 22+, Git. The pipeline uses the agent CLIs you have (`claude`, `codex`, `grok`), and fastlane for releases. Pull requests need the GitHub CLI (`gh`).

**macOS / Linux**

```bash
git clone https://github.com/torisKR/herdr-toris-neon.git
cd herdr-toris-neon
./install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/torisKR/herdr-toris-neon.git
cd herdr-toris-neon
.\install.ps1
```

The installer backs up your herdr config and keys before changing them, installs the theme, layouts, mods and shortcuts, and never replaces a shortcut you changed yourself. Afterwards, **Update** in the + menu keeps it current.

## Terminal herdr plugin

The same pack works in terminal herdr: `prefix a` ALL agents, `prefix d` Devices, `prefix u` text browser, `prefix f` files and pull requests (`prefix` is `ctrl+b`). Dragging text in a remote pane copies it to your own clipboard.

```bash
herdr plugin install torisKR/herdr-toris-neon/plugin
```

## Tested on

- Windows 11 with the Herdr desktop app: all features above were run in the app; the pipeline was run end to end with a stand-in agent and its first stage with a real one on macOS.
- macOS: the pipeline's first stage, screenshot paste (local and into a Windows terminal) and the installer's pieces were run. The later pipeline stages and store uploads have not been run for real yet.

## Credits

The colors were inspired by a screenshot of the Cyber Purple 77 theme for VS Code and picked anew for herdr's color tokens. The graphical browser on macOS/Linux is [herdr-web-browser](https://github.com/MattJColes/herdr-web-browser) (MIT).

## License

MIT
