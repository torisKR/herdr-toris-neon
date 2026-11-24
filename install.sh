#!/usr/bin/env sh
# herdr-toris-neon installer for macOS / Linux.
# Installs what applies to this machine: the terminal herdr config and plugin when `herdr`
# is installed, and the theme, layouts, mods and shortcuts when the Herdr desktop app is.
set -eu
here=$(cd "$(dirname "$0")" && pwd)

# 1. the nv binary (built with cargo when Rust is installed, otherwise downloaded)
sh "$here/plugin/fetch-bin.sh"
nv="$here/plugin/bin/nv"

# 2. terminal herdr
if command -v herdr >/dev/null 2>&1; then
  cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/herdr"
  mkdir -p "$cfg_dir"
  if [ -f "$cfg_dir/config.toml" ]; then
    backup="$cfg_dir/config.toml.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$cfg_dir/config.toml" "$backup"
    echo "backed up existing config -> $backup"
  fi
  cp "$here/config/config.toml" "$cfg_dir/config.toml"
  echo "installed config -> $cfg_dir/config.toml"
  if herdr plugin link "$here/plugin" >/dev/null; then echo "linked plugin neon-violet"; else echo "warning: could not link the plugin - run: herdr plugin link \"$here/plugin\""; fi
  herdr server reload-config >/dev/null 2>&1 || true
fi

if [ -d "$HOME/.config/ghostty" ]; then
  mkdir -p "$HOME/.config/ghostty/themes"
  cp "$here/terminal/ghostty-neon-violet" "$HOME/.config/ghostty/themes/neon-violet"
  echo "installed Ghostty theme -> add 'theme = neon-violet' to ~/.config/ghostty/config"
fi

# 3. Herdr desktop app
app="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
if [ -d "$app" ]; then
  mkdir -p "$app/themes" "$app/layouts" "$app/mods" "$app/bin"
  # Remove this pack's retired hooks before replacing the older nv binary.
  if [ -d "$app/mods/todos" ]; then
    if [ -x "$app/bin/nv" ] && "$app/bin/nv" todo path >/dev/null 2>&1; then
      "$app/bin/nv" todo hooks remove
    fi
    retired="$app/backups/retired-todos-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$retired"
    mv "$app/mods/todos" "$retired/"
  fi
  cp "$nv" "$app/bin/nv"
  cp "$here/app/browser/nv-preview.mjs" "$app/bin/nv-preview.mjs"
  cp "$here/app/browser/nv-web.mjs" "$app/bin/nv-web.mjs"
  cp "$here/app/pipeline/nv-pipeline.mjs" "$app/bin/nv-pipeline.mjs"
  cp "$here/app/pipeline/nv-graphics.mjs" "$app/bin/nv-graphics.mjs"
  cp "$here/app/pipeline/nv-replica.mjs" "$app/bin/nv-replica.mjs"
  cp "$here/app/pipeline/nv-remote.mjs" "$app/bin/nv-remote.mjs"
  cp "$here/app/pipeline/nv-bot.mjs" "$app/bin/nv-bot.mjs"
  mkdir -p "$app/pipeline/stages" && cp "$here"/app/pipeline/stages/*.md "$app/pipeline/stages/"
  # The Replica skill pack (app/pipeline/replica/UPSTREAM.md): eleven skills and their Python tools, copied
  # as one folder so the paths between them hold. It is the copy in this repository, never a download.
  mkdir -p "$app/pipeline/replica" && cp -R "$here/app/pipeline/replica/." "$app/pipeline/replica/"
  cp "$here/app/usage/nv-usage.mjs" "$app/bin/nv-usage.mjs"
  cp "$here/app/today/nv-today.mjs" "$app/bin/nv-today.mjs"
  cp "$here/app/play/nv-play.mjs" "$app/bin/nv-play.mjs"
  cp "$here/app/themes/neon-violet.json" "$app/themes/"
  cp "$here/app/layouts/all-agents.json" "$here/app/layouts/neon-violet.json" "$app/layouts/"
  cp -R "$here/app/mods/all-agents" "$here/app/mods/devices" "$here/app/mods/prs" "$here/app/mods/nv-browser" "$here/app/mods/nv-browser-frame" "$here/app/mods/nv-code" "$here/app/mods/nv-shortcuts" "$here/app/mods/nv-usage" "$here/app/mods/editor" "$here/app/mods/nv-tabs" "$here/app/mods/nv-new-menu" "$here/app/mods/nv-files" "$here/app/mods/nv-web" "$here/app/mods/nv-toggle-agents" "$here/app/mods/nv-toggle-prs" "$here/app/mods/nv-paste" "$here/app/mods/nv-pipeline" "$here/app/mods/nv-today" "$here/app/mods/nv-play" "$here/app/mods/nv-sidebar" "$here/app/mods/nv-update" "$app/mods/"
  "$app/bin/nv" merge-keys "$app/keys.json" "$here/app/keys.json"
  # Where this pack lives, so Update in the + menu can pull and install again.
  printf '{"repo": "%s"}\n' "$(printf %s "$here" | sed 's/\\/\\\\/g; s/"/\\"/g')" > "$app/nv-pack.json"
  # Browser setup is optional; a missing toolchain/download must not interrupt the pack migration.
  if command -v cargo >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
    if ! sh "$here/scripts/install-browser.sh"; then
      echo "warning: Browser setup failed; the desktop pack is installed. Retry ./scripts/install-browser.sh." >&2
    fi
  else
    echo "warning: Browser setup needs Rust/Cargo and Git. Install them, then run ./scripts/install-browser.sh." >&2
  fi
  # Agent skill: how Claude Code / Codex drive Herdr, hc and the browser (only where those agents are set up).
  for skills in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    if [ -d "$skills" ]; then
      mkdir -p "$skills/herdr-hc" && cp "$here/skills/herdr-hc/SKILL.md" "$skills/herdr-hc/SKILL.md"
      echo "installed skill herdr-hc -> $skills/herdr-hc"
      # The Replica skills, for agents that load skills by name. A folder of the same name that this
      # pack did not put there is the person's own and is left as it is.
      kept=""
      for skill in "$here"/app/pipeline/replica/replica-*; do
        name="${skill##*/}"
        if [ ! -d "$skills/$name" ] || [ -f "$skills/$name/.herdr-toris-neon" ]; then
          mkdir -p "$skills/$name" && cp -R "$skill/." "$skills/$name/" && : > "$skills/$name/.herdr-toris-neon"
        else
          kept="$kept $name"
        fi
      done
      echo "installed the Replica skills -> $skills/replica-*${kept:+ (left as they were:$kept)}"
    fi
  done
  # Bots: "@@name <request>" typed in Claude Code or Codex goes to that bot (docs/BOTS.md). The hook is
  # appended to the agents' own hook lists (a .bak-nv-bot copy is kept); "nv-bot hooks remove" takes it out.
  if command -v node >/dev/null 2>&1; then
    node "$app/bin/nv-bot.mjs" hooks install || echo "warning: the @@bot hook was not installed; run: node \"$app/bin/nv-bot.mjs\" hooks install" >&2
  fi
  echo "installed Herdr app pack -> $app"
  echo "  layout: herdr-app do layout.switch --name neon-violet   (dark and translucent)"
  echo "  ALL agents ctrl+shift+a · Devices ctrl+shift+d · Pull requests ctrl+shift+g · Browser ctrl+shift+u (press again: back/close)"
  echo "  Code highlighting ctrl+shift+h · Keyboard shortcuts ctrl+shift+k (cmd on macOS)"
fi
echo "done. iTerm2: import terminal/neon-violet.itermcolors (Settings > Profiles > Colors > Color Presets)."
