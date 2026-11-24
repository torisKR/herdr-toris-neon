# herdr-toris-neon installer for Windows.
# Installs what applies to this machine: the terminal herdr config and plugin when `herdr`
# is installed, and the theme, layouts, mods and shortcuts when the Herdr desktop app is.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# 1. the nv binary (built with cargo when Rust is installed, otherwise downloaded)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'plugin\fetch-bin.ps1')
if ($LASTEXITCODE -ne 0) { throw 'could not get the nv binary' }
$nv = Join-Path $here 'plugin\bin\nv.exe'

# 2. terminal herdr
if (Get-Command herdr -ErrorAction SilentlyContinue) {
  $cfgDir = Join-Path $env:APPDATA 'herdr'
  New-Item -ItemType Directory -Force $cfgDir | Out-Null
  $cfg = Join-Path $cfgDir 'config.toml'
  if (Test-Path $cfg) {
    $backup = "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $cfg $backup
    "backed up existing config -> $backup"
  }
  Copy-Item (Join-Path $here 'config\config.toml') $cfg -Force
  "installed config -> $cfg"

  $ErrorActionPreference = 'Continue'
  & herdr plugin link (Join-Path $here 'plugin') 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { 'linked plugin neon-violet' }
  else { Write-Warning 'could not link the plugin (is herdr running as administrator?). Run in that terminal: herdr plugin link "<repo>\plugin"' }
  & herdr server reload-config 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { 'herdr is not running or not reachable from this terminal - press prefix+shift+r inside herdr to reload the config.' }
  $ErrorActionPreference = 'Stop'
}

$frag = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\Fragments\herdr-neon-violet'
New-Item -ItemType Directory -Force $frag | Out-Null
Copy-Item (Join-Path $here 'terminal\windows-terminal.json') (Join-Path $frag 'neon-violet.json') -Force
'added Windows Terminal color scheme "Neon Violet" (restart Windows Terminal, then pick it in Settings > Profile > Appearance)'

# 3. Herdr desktop app
$app = if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }
if (Test-Path $app) {
  foreach ($d in 'themes','layouts','mods','bin') { New-Item -ItemType Directory -Force (Join-Path $app $d) | Out-Null }
  $retiredMod = Join-Path $app 'mods\todos'
  if (Test-Path $retiredMod) {
    $oldNv = Join-Path $app 'bin\nv.exe'
    if (Test-Path $oldNv) {
      & $oldNv todo path *> $null
      if ($LASTEXITCODE -eq 0) {
        & $oldNv todo hooks remove
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the retired to-do hooks' }
      }
    }
    $retired = Join-Path $app ('backups\retired-todos-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force $retired | Out-Null
    Move-Item $retiredMod $retired
  }
  Copy-Item $nv (Join-Path $app 'bin\nv.exe') -Force
  Copy-Item (Join-Path $here 'app\browser\nv-preview.mjs') (Join-Path $app 'bin\nv-preview.mjs') -Force
  Copy-Item (Join-Path $here 'app\browser\nv-web.mjs') (Join-Path $app 'bin\nv-web.mjs') -Force
  Copy-Item (Join-Path $here 'app\pipeline\nv-pipeline.mjs') (Join-Path $app 'bin\nv-pipeline.mjs') -Force
  Copy-Item (Join-Path $here 'app\pipeline\nv-graphics.mjs') (Join-Path $app 'bin\nv-graphics.mjs') -Force
  Copy-Item (Join-Path $here 'app\pipeline\nv-replica.mjs') (Join-Path $app 'bin\nv-replica.mjs') -Force
  Copy-Item (Join-Path $here 'app\pipeline\nv-remote.mjs') (Join-Path $app 'bin\nv-remote.mjs') -Force
  Copy-Item (Join-Path $here 'app\pipeline\nv-bot.mjs') (Join-Path $app 'bin\nv-bot.mjs') -Force
  # The Replica skill pack (app\pipeline\replica\UPSTREAM.md): eleven skills and their Python tools, copied
  # as one folder so the paths between them hold. It is the copy in this repository, never a download.
  New-Item -ItemType Directory -Force (Join-Path $app 'pipeline\replica') | Out-Null
  Copy-Item (Join-Path $here 'app\pipeline\replica\*') (Join-Path $app 'pipeline\replica') -Recurse -Force
  New-Item -ItemType Directory -Force (Join-Path $app 'pipeline\stages') | Out-Null
  Copy-Item (Join-Path $here 'app\pipeline\stages\*.md') (Join-Path $app 'pipeline\stages') -Force
  Copy-Item (Join-Path $here 'app\usage\nv-usage.mjs') (Join-Path $app 'bin\nv-usage.mjs') -Force
  Copy-Item (Join-Path $here 'app\today\nv-today.mjs') (Join-Path $app 'bin\nv-today.mjs') -Force
  Copy-Item (Join-Path $here 'app\play\nv-play.mjs') (Join-Path $app 'bin\nv-play.mjs') -Force
  Copy-Item (Join-Path $here 'app\themes\neon-violet.json') (Join-Path $app 'themes') -Force
  foreach ($l in 'all-agents','neon-violet') { Copy-Item (Join-Path $here "app\layouts\$l.json") (Join-Path $app 'layouts') -Force }
  foreach ($m in 'all-agents','devices','prs','nv-browser','nv-browser-frame','nv-code','nv-shortcuts','nv-usage','editor','nv-tabs','nv-new-menu','nv-files','nv-web','nv-toggle-agents','nv-toggle-prs','nv-paste','nv-pipeline','nv-today','nv-play','nv-sidebar','nv-update') { Copy-Item (Join-Path $here "app\mods\$m") (Join-Path $app 'mods') -Recurse -Force }
  & (Join-Path $app 'bin\nv.exe') merge-keys (Join-Path $app 'keys.json') (Join-Path $here 'app\keys.json')
  # Where this pack lives, so Update in the + menu can pull and install again.
  [IO.File]::WriteAllText((Join-Path $app 'nv-pack.json'), (@{ repo = $here } | ConvertTo-Json -Compress))
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Warning 'Browser (Ctrl+Shift+U) needs Node.js 22+ and Chrome or Edge.' }
  # Agent skill: how Claude Code / Codex drive Herdr, hc and the browser (only where those agents are set up).
  foreach ($skills in (Join-Path $env:USERPROFILE '.claude\skills'), (Join-Path $env:USERPROFILE '.agents\skills')) {
    if (Test-Path $skills) {
      $dest = Join-Path $skills 'herdr-hc'
      New-Item -ItemType Directory -Force $dest | Out-Null
      Copy-Item (Join-Path $here 'skills\herdr-hc\SKILL.md') (Join-Path $dest 'SKILL.md') -Force
      "installed skill herdr-hc -> $dest"
      # The Replica skills, for agents that load skills by name. A folder of the same name that this
      # pack did not put there is the person's own and is left as it is.
      $kept = @()
      foreach ($skill in (Get-ChildItem (Join-Path $here 'app\pipeline\replica') -Directory -Filter 'replica-*')) {
        $to = Join-Path $skills $skill.Name
        if ((-not (Test-Path $to)) -or (Test-Path (Join-Path $to '.herdr-toris-neon'))) {
          New-Item -ItemType Directory -Force $to | Out-Null
          Copy-Item (Join-Path $skill.FullName '*') $to -Recurse -Force
          [IO.File]::WriteAllText((Join-Path $to '.herdr-toris-neon'), '')
        } else { $kept += $skill.Name }
      }
      "installed the Replica skills -> $skills\replica-*" + $(if ($kept) { " (left as they were: $($kept -join ', '))" } else { '' })
    }
  }
  # Bots: "@@name <request>" typed in Claude Code or Codex goes to that bot (docs\BOTS.md). The hook is
  # appended to the agents' own hook lists (a .bak-nv-bot copy is kept); "nv-bot hooks remove" takes it out.
  if (Get-Command node -ErrorAction SilentlyContinue) {
    & node (Join-Path $app 'bin\nv-bot.mjs') hooks install
    if ($LASTEXITCODE -ne 0) { Write-Warning "the @@bot hook was not installed; run: node $(Join-Path $app 'bin\nv-bot.mjs') hooks install" }
  }
  "installed Herdr app pack -> $app"
  '  layout: herdr-app do layout.switch --name neon-violet   (dark and translucent)'
  '  ALL agents ctrl+shift+a · Devices ctrl+shift+d · Pull requests ctrl+shift+g · Browser ctrl+shift+u (press again: back/close)'
  '  Code highlighting ctrl+shift+h · Keyboard shortcuts ctrl+shift+k (cmd on macOS)'
}
'done.'
