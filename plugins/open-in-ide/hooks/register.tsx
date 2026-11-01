import type { Engine, Register } from 'claude-code'

const EXTENSIONS = [
  // C, C++, C#
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'ipp', 'tpp', 'cs',
  // Shaders: Unreal, Unity, HLSL, GLSL
  'usf', 'ush', 'shader', 'compute', 'cginc', 'hlsl', 'hlsli', 'glsl', 'vert', 'frag',
  // Unity UI and project files, Unreal descriptors
  'uxml', 'uss', 'asmdef', 'uplugin', 'uproject',
  // Other languages
  'java', 'kt', 'kts', 'go', 'rs', 'swift', 'py', 'rb', 'php', 'lua', 'dart', 'scala', 'fs', 'vb',
  // Web
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  // Scripts, data, config and docs
  'sh', 'bash', 'ps1', 'psm1', 'bat', 'cmd', 'sql', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf',
  'csproj', 'vcxproj', 'props', 'targets', 'gradle', 'cmake', 'md', 'txt',
].join('|')
const CODE_FILE = new RegExp(`\\.(${EXTENSIONS})$`, 'i')
const MD_LINK = /\[([^\]\n]*)\]\(<?([^)\s>]+)>?\)/g
// A file reference anywhere in the text, in code spans too: `Foo.cs`, `Foo.cs:88`, `Source/Foo.cpp:42:7`, `Foo.cs#L10`,
// `Foo.cs:line 88`, and ranges `Foo.cs:10-20`, `Foo.cs:10..20`, `Foo.cs#L10-L20` (opened at their first line)
const TEXT_REF = new RegExp(
  String.raw`(?<![\w/\\.-])((?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:${EXTENSIONS}))(?::(?:line )?(\d+)(?::\d+)?(?:(?:[-–]|\.\.)\d+)?|#L(\d+)(?:(?:-|\.\.)L?\d+)?)?(?![\w-]|\.\w|:\d)`,
  'gi',
)
// Library names written like files ("Node.js", "Vue.js"): a reference only with a folder or a line
const LIBRARY_NAME = /^(node|vue|next|nuxt|three|express|react|angular|d3|chart|ember|backbone|alpine|solid|deno|p5|anime|moment|socket|nest|gatsby|preact|knockout|meteor|pixi|babylon|matter|phaser|tone|paper|fabric|video|ml5|tf|brain|discord|immutable|marked|highlight|require|ext)\.js$/i

// path is as written in the reply, relative or absolute; open() turns it into a file on disk. line 0: none given
type Target = { path: string; line: number }
type Ide = 'rider' | 'visualstudio' | 'vscode' | 'custom'

// Unity's com.unity.ide.visualstudio COMIntegration, as PowerShell: find the running Visual Studio whose
// solution is one of IDE_LINKS_SLNS (nearest first), else start the newest one on the nearest solution and
// wait for it in the Running Object Table, then open the file there at the line
const VISUAL_STUDIO_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class IdeLinksRot {
  [DllImport("ole32.dll")] static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable rot);
  [DllImport("ole32.dll")] static extern int CreateBindCtx(int reserved, out IBindCtx ctx);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int processId);
  public static List<object> VisualStudios() {
    var found = new List<object>();
    IRunningObjectTable rot; IBindCtx ctx; IEnumMoniker monikers;
    if (GetRunningObjectTable(0, out rot) != 0 || CreateBindCtx(0, out ctx) != 0) return found;
    rot.EnumRunning(out monikers);
    var moniker = new IMoniker[1];
    while (monikers.Next(1, moniker, IntPtr.Zero) == 0) {
      string name;
      try { moniker[0].GetDisplayName(ctx, null, out name); } catch { continue; }
      if (!name.StartsWith("!VisualStudio.DTE")) continue;
      object dte;
      if (rot.GetObject(moniker[0], out dte) == 0) found.Add(dte);
    }
    return found;
  }
}
"@
$solutions = @($env:IDE_LINKS_SLNS -split '\\|' | Where-Object { $_ })
$file = $env:IDE_LINKS_FILE
$line = [int]$env:IDE_LINKS_LINE

function Find-VisualStudio {
  $any = $null
  foreach ($dte in [IdeLinksRot]::VisualStudios()) {
    try {
      $open = $dte.Solution.FullName
      if (-not $any) { $any = $dte }
      foreach ($sln in $solutions) {
        if ($open -and [IO.Path]::GetFullPath($open) -ieq [IO.Path]::GetFullPath($sln)) { return $dte }
      }
    } catch {}
  }
  if ($solutions.Count -eq 0) { return $any }
  return $null
}

$dte = Find-VisualStudio
if (-not $dte) {
  $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\\Installer\\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw 'Visual Studio was not found (no vswhere.exe)' }
  $devenv = & $vswhere -latest -property productPath
  if (-not $devenv) { throw 'Visual Studio was not found' }
  if ($solutions.Count -gt 0) { Start-Process $devenv -ArgumentList ('"' + $solutions[0] + '"') } else { Start-Process $devenv }
  for ($i = 0; $i -lt 120 -and -not $dte; $i++) { Start-Sleep -Milliseconds 1000; $dte = Find-VisualStudio }
  if (-not $dte) { throw 'Visual Studio did not open the solution within two minutes' }
}

# A busy Visual Studio rejects calls for a while, so each step is retried
for ($try = 0; $try -lt 20; $try++) {
  try {
    $dte.MainWindow.Visible = $true
    [void]$dte.ItemOperations.OpenFile($file)
    $dte.ActiveDocument.Selection.GotoLine($line, $false)
    [void][IdeLinksRot]::AllowSetForegroundWindow(-1)
    $dte.MainWindow.Activate()
    return
  } catch { Start-Sleep -Milliseconds 500 }
}
throw 'Visual Studio did not respond'
`

// `Source/Foo.cpp`, `Source/Foo.cpp:42`, `Source/Foo.cpp:42:7`, `Source/Foo.cpp#L42`, or a range `:42-50`, `:42..50` or `#L42-L50`
function parseTarget(href: string): Target | null {
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(href)) {
    return null
  }
  const m = /^(.*?)(?::(\d+)(?::\d+)?(?:(?:-|\.\.)\d+)?|#L(\d+)(?:(?:-|\.\.)L?\d+)?)?$/.exec(href)
  if (!m || !CODE_FILE.test(m[1])) {
    return null
  }
  return { path: decodeURI(m[1]), line: Number(m[2] ?? m[3] ?? 0) }
}

// Forward slashes throughout: Windows and the IDEs all take them
function absolute(path: string, cwd: string): string {
  const p = path.replace(/\\/g, '/')
  if (/^[a-z]:\//i.test(p) || p.startsWith('//')) {
    return p
  }
  return `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

const win = (p: string) => p.replace(/\//g, '\\')
const quoted = (p: string) => `"${win(p)}"`

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    await $.fs.stat(path)
    return true
  } catch {
    return false
  }
}

// Bare names like `Foo.cs` found earlier, by folder and name
const found = new Map<string, string>()

// The file a reference names: the path itself, else a file under the session folder whose path ends
// with it (the shortest such path), since replies often give just the file name
async function resolveFile($: Engine, ref: string): Promise<string | null> {
  const cwd = await $.session.cwd()
  const path = absolute(ref, cwd)
  if (await exists($, path)) {
    return path
  }
  const tail = `/${ref.replace(/\\/g, '/').replace(/^\.\//, '')}`.toLowerCase()
  if (/^\/[a-z]:\//.test(tail) || tail.startsWith('///')) {
    return null
  }
  const key = `${cwd}|${tail}`
  if (found.has(key)) {
    return found.get(key) ?? null
  }
  $.ui.toast(`Looking for ${tail.slice(tail.lastIndexOf('/') + 1)}...`)
  const r = await $.process.run(
    [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-ChildItem -LiteralPath $env:IDE_LINKS_ROOT -Recurse -File -Filter $env:IDE_LINKS_NAME -ErrorAction SilentlyContinue | ForEach-Object FullName',
    ],
    { env: { IDE_LINKS_ROOT: win(cwd), IDE_LINKS_NAME: tail.slice(tail.lastIndexOf('/') + 1) }, timeoutMs: 120000 },
  )
  const match = r.stdout
    .split(/\r?\n/)
    .map(p => p.trim().replace(/\\/g, '/'))
    .filter(p => p && p.toLowerCase().endsWith(tail))
    .sort((a, b) => a.length - b.length)[0]
  if (match) {
    found.set(key, match)
  }
  return match ?? null
}

// The configured rider64.exe, else the install the newest Rider records in %LOCALAPPDATA%/JetBrains/Rider<version>/.home
async function findRider($: Engine, configured: string): Promise<string | null> {
  if (configured) {
    return configured
  }
  const localAppData = await $.env.get('LOCALAPPDATA')
  if (!localAppData) {
    return null
  }
  const root = `${localAppData.replace(/\\/g, '/')}/JetBrains`
  try {
    const versions = (await $.fs.list(root))
      .filter(entry => entry.kind === 'dir' && /^Rider\d/i.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const version of versions) {
      try {
        const home = String(await $.fs.read(`${root}/${version}/.home`)).trim().replace(/\\/g, '/')
        if (await exists($, `${home}/bin/rider64.exe`)) {
          return `${home}/bin/rider64.exe`
        }
      } catch {}
    }
  } catch {}
  return null
}

async function findVisualStudio($: Engine): Promise<boolean> {
  return exists($, 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe')
}

// Code.exe from the user or the system installer
async function findVsCode($: Engine): Promise<string | null> {
  const localAppData = await $.env.get('LOCALAPPDATA')
  const candidates = [
    ...(localAppData ? [`${localAppData.replace(/\\/g, '/')}/Programs/Microsoft VS Code/Code.exe`] : []),
    'C:/Program Files/Microsoft VS Code/Code.exe',
  ]
  for (const exe of candidates) {
    if (await exists($, exe)) {
      return exe
    }
  }
  return null
}

// The editor setting, or under `auto` the first of Rider, Visual Studio and VS Code that is running, else
// installed; `custom` is only ever chosen by name
async function pickIde($: Engine, setting: string, riderPath: string): Promise<Ide | null> {
  if (setting === 'rider' || setting === 'visualstudio' || setting === 'vscode' || setting === 'custom') {
    return setting
  }
  try {
    const r = await $.process.run(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Get-Process rider64, devenv, Code -ErrorAction SilentlyContinue | ForEach-Object Name'],
      { timeoutMs: 10000 },
    )
    const running = r.stdout.toLowerCase()
    if (running.includes('rider64')) {
      return 'rider'
    }
    if (running.includes('devenv')) {
      return 'visualstudio'
    }
    if (/\bcode\b/.test(running)) {
      return 'vscode'
    }
  } catch {}
  if (await findRider($, riderPath)) {
    return 'rider'
  }
  if (await findVisualStudio($)) {
    return 'visualstudio'
  }
  if (await findVsCode($)) {
    return 'vscode'
  }
  return null
}

// Every solution or project Rider remembers opening, lowercased, from each Rider*/options/recentSolutions.xml
async function recentRiderProjects($: Engine): Promise<Set<string>> {
  const recent = new Set<string>()
  const appData = await $.env.get('APPDATA')
  if (!appData) {
    return recent
  }
  const root = `${appData.replace(/\\/g, '/')}/JetBrains`
  try {
    for (const entry of await $.fs.list(root)) {
      if (entry.kind !== 'dir' || !/^Rider/i.test(entry.name)) {
        continue
      }
      try {
        const xml = String(await $.fs.read(`${root}/${entry.name}/options/recentSolutions.xml`))
        for (const m of xml.matchAll(/entry key="([^"]+)"/g)) {
          recent.add(m[1].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
        }
      } catch {}
    }
  } catch {}
  return recent
}

// The .sln/.slnx and .uproject files from the file's folder upward, nearest first
async function projectsAbove($: Engine, file: string): Promise<{ solutions: string[]; uprojects: string[] }> {
  const solutions: string[] = []
  const uprojects: string[] = []
  let dir = file.slice(0, file.lastIndexOf('/'))
  while (dir.includes('/')) {
    try {
      for (const entry of await $.fs.list(dir)) {
        if (entry.kind === 'file' && /\.slnx?$/i.test(entry.name)) {
          solutions.push(`${dir}/${entry.name}`)
        } else if (entry.kind === 'file' && /\.uproject$/i.test(entry.name)) {
          uprojects.push(`${dir}/${entry.name}`)
        }
      }
    } catch {}
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }
  return { solutions, uprojects }
}

// For Rider: the nearest project or folder Rider has opened before (a source-built engine's UE4.sln over
// the game's .uproject below it), else the nearest .sln/.slnx, else the nearest .uproject, else a folder
// (the session's when the file is in it, else the file's own), since Rider's launcher needs a project first
async function riderProject($: Engine, file: string): Promise<string> {
  const { solutions, uprojects } = await projectsAbove($, file)
  const folders: string[] = []
  for (let dir = file.slice(0, file.lastIndexOf('/')); dir.includes('/'); dir = dir.slice(0, dir.lastIndexOf('/'))) {
    folders.push(dir)
  }
  const recent = await recentRiderProjects($)
  const known = [...solutions, ...uprojects, ...folders].filter(p => recent.has(p.toLowerCase()))
  if (known.length > 0) {
    return known.sort((a, b) => b.split('/').length - a.split('/').length)[0]
  }
  const cwd = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '')
  const inSession = file.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)
  return solutions[0] ?? uprojects[0] ?? (inSession ? cwd : folders[0])
}

// A launcher started from inside Claude's process tree cannot reach an already running Rider, so WMI
// starts it outside that tree; the command line travels in an env var to avoid quoting
async function launchDetached($: Engine, commandLine: string): Promise<string | null> {
  const r = await $.process.run(
    [
      'powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      '(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:IDE_LINKS_CMD; CurrentDirectory = $env:USERPROFILE }).ReturnValue',
    ],
    { env: { IDE_LINKS_CMD: commandLine }, timeoutMs: 20000 },
  )
  return r.exitCode === 0 && r.stdout.trim() === '0' ? null : `WMI returned ${r.stdout.trim() || r.exitCode}`
}

async function openInRider($: Engine, riderPath: string, t: Target): Promise<string | null> {
  const rider = await findRider($, riderPath)
  if (!rider) {
    return 'Rider was not found: set the "Rider executable" option to rider64.exe'
  }
  // Unity's order: solution first, then --line/--column, then the file
  const project = await riderProject($, t.path)
  return launchDetached($, [quoted(rider), quoted(project), '--line', String(t.line), '--column', '1', quoted(t.path)].join(' '))
}

async function openInVisualStudio($: Engine, t: Target): Promise<string | null> {
  const { solutions } = await projectsAbove($, t.path)
  const r = await $.process.run(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', '& ([scriptblock]::Create($env:IDE_LINKS_SCRIPT))'],
    {
      env: { IDE_LINKS_SCRIPT: VISUAL_STUDIO_SCRIPT, IDE_LINKS_SLNS: solutions.map(win).join('|'), IDE_LINKS_FILE: win(t.path), IDE_LINKS_LINE: String(t.line) },
      timeoutMs: 180000,
    },
  )
  return r.exitCode === 0 ? null : r.stderr.trim().split('\n')[0] || `exit ${r.exitCode}`
}

async function openInVsCode($: Engine, t: Target): Promise<string | null> {
  const code = await findVsCode($)
  if (code) {
    // -g opens file:line:column, in the window whose folder holds the file when there is one
    return launchDetached($, `${quoted(code)} -g "${win(t.path)}:${t.line}:1"`)
  }
  return launchDetached($, `rundll32.exe url.dll,FileProtocolHandler vscode://file/${encodeURI(t.path)}:${t.line}:1`)
}

// The custom command line with {file}, {line}, {column} and {folder} (the session's) filled in
function customCommandLine(template: string, t: Target, cwd: string): string {
  const values: Record<string, string> = { file: win(t.path), line: String(t.line), column: '1', folder: win(cwd.replace(/[\\/]+$/, '')) }
  return template.replace(/\{(file|line|column|folder)\}/gi, (_, name: string) => values[name.toLowerCase()])
}

async function openInCustom($: Engine, template: string, t: Target): Promise<string | null> {
  if (!/\{file\}/i.test(template)) {
    return 'set a custom command containing {file} with /open-in-ide custom <command>'
  }
  return launchDetached($, customCommandLine(template, t, await $.session.cwd()))
}

async function open($: Engine, setting: string, riderPath: string, custom: string, ref: Target): Promise<void> {
  try {
    const file = await resolveFile($, ref.path)
    if (!file) {
      $.ui.toast(`${ref.path} was not found under ${await $.session.cwd()}`)
      return
    }
    const t = { path: file, line: Math.max(1, ref.line) }
    const ide = await pickIde($, setting, riderPath)
    if (!ide) {
      $.ui.toast('No IDE found: install Rider, Visual Studio or VS Code, or set a custom command with /open-in-ide custom <command>')
      return
    }
    const failure =
      ide === 'rider' ? await openInRider($, riderPath, t)
      : ide === 'visualstudio' ? await openInVisualStudio($, t)
      : ide === 'vscode' ? await openInVsCode($, t)
      : await openInCustom($, custom, t)
    if (failure) {
      $.ui.toast(`Could not open ${t.path.slice(t.path.lastIndexOf('/') + 1)}: ${failure}`)
    }
  } catch (err) {
    $.ui.toast(`Could not open the file: ${String(err)}`)
  }
}

const EDITORS = ['auto', 'rider', 'visualstudio', 'vscode', 'custom']

// The /open-in-ide choice, kept across sessions, wins over the Editor option
async function editor($: Engine, option: string): Promise<string> {
  const chosen = await $.store.get('editor')
  return typeof chosen === 'string' && EDITORS.includes(chosen) ? chosen : option
}

// The custom command from /open-in-ide custom, else the Custom command option
async function customCommand($: Engine, option: string): Promise<string> {
  const chosen = await $.store.get('customCommand')
  return typeof chosen === 'string' && chosen ? chosen : option
}

const PLACEMENTS = ['paragraph', 'end']

// Where the buttons go: under each paragraph, or all at the end of the reply; /open-in-ide buttons wins over the option
async function placement($: Engine, option: string): Promise<string> {
  const chosen = await $.store.get('buttons')
  return typeof chosen === 'string' && PLACEMENTS.includes(chosen) ? chosen : option
}

type Ref = { label: string; target: Target }

// The code references in one block: links first, so their labels win, then the rest of the text;
// those with a line before those without
function references(text: string): Ref[] {
  const refs: Ref[] = []
  for (const m of text.matchAll(MD_LINK)) {
    const t = parseTarget(m[2])
    if (t) {
      refs.push({ label: m[1] || m[2], target: t })
    }
  }
  for (const m of text.replace(MD_LINK, ' ').matchAll(TEXT_REF)) {
    if (!m[2] && !m[3] && LIBRARY_NAME.test(m[1])) {
      continue
    }
    refs.push({ label: m[0], target: { path: m[1], line: Number(m[2] ?? m[3] ?? 0) } })
  }
  return [...refs.filter(x => x.target.line > 0), ...refs.filter(x => x.target.line === 0)]
}

// The reply's blocks, split at blank lines outside code fences; an indented block (a list item's
// continuation) stays with the one before it, so lists and fences render as they would whole
function blocks(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fence: string | null = null
  let gap = false
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null && line.trim() === '') {
      gap = current.length > 0
      current.push(line)
      continue
    }
    if (gap && fence === null && !/^\s/.test(line)) {
      out.push(current.join('\n').replace(/\n+$/, ''))
      current = []
    }
    gap = false
    current.push(line)
    if (marker && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null
    }
  }
  if (current.length > 0) {
    out.push(current.join('\n'))
  }
  return out
}

// The reply in sections, each ending with a block that has references and carrying its buttons;
// a reference already given a button earlier in the reply gets none again, 20 buttons at most
function buttonSections(text: string): { text: string; targets: Ref[] }[] {
  const sections: { text: string; targets: Ref[] }[] = []
  const given: Ref[] = []
  const file = (t: Target) => t.path.replace(/\\/g, '/').toLowerCase()
  let pending: string[] = []
  for (const block of blocks(text)) {
    pending.push(block)
    const targets: Ref[] = []
    for (const ref of references(block)) {
      // A file without a line gets no button when the reply already has one for it
      const taken = [...given, ...targets].some(
        x => x.label === ref.label || (file(x.target) === file(ref.target) && (x.target.line === ref.target.line || ref.target.line === 0)),
      )
      if (!taken && given.length + targets.length < 20) {
        targets.push(ref)
      }
    }
    if (targets.length > 0) {
      sections.push({ text: pending.join('\n\n'), targets })
      given.push(...targets)
      pending = []
    }
  }
  if (pending.length > 0) {
    sections.push({ text: pending.join('\n\n'), targets: [] })
  }
  return sections
}

export const register: Register = (on, options) => {
  const riderPath = String(options.riderPath ?? '').trim()
  const option = String(options.editor ?? 'auto')
  const customOption = String(options.customCommand ?? '').trim()
  const placementOption = PLACEMENTS.includes(String(options.buttons)) ? String(options.buttons) : 'paragraph'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'open-in-ide',
      description: 'Choose the IDE code links open in: auto, rider, visualstudio, vscode, or custom <command with {file} {line}>; buttons paragraph|end',
    })
    return next(e)
  })

  on('command.run', { command: 'open-in-ide' }, async ($, e) => {
    const args = e.args.trim()
    const choice = args.split(/\s+/)[0].toLowerCase()
    const rest = args.slice(choice.length).trim()
    if (!choice) {
      const current = await editor($, option)
      const command = await customCommand($, customOption)
      const where = await placement($, placementOption)
      return {
        text: `Code links open in: ${current}${current === 'custom' ? ` (${command || 'no command set'})` : ''}. ` +
          `Buttons appear ${where === 'end' ? 'at the end of the reply' : 'under each paragraph'}. ` +
          `Change it with /open-in-ide ${EDITORS.join('|')}, /open-in-ide custom <command> (using {file}, {line}, {column} and {folder}), ` +
          `or /open-in-ide buttons ${PLACEMENTS.join('|')}.`,
      }
    }
    if (choice === 'buttons') {
      const where = rest.toLowerCase()
      if (!PLACEMENTS.includes(where)) {
        return { text: 'Use /open-in-ide buttons paragraph (under each paragraph) or /open-in-ide buttons end (at the end of the reply).' }
      }
      await $.store.set('buttons', where)
      return { text: where === 'end' ? 'Buttons now appear at the end of the reply.' : 'Buttons now appear under each paragraph.' }
    }
    if (!EDITORS.includes(choice)) {
      return { text: `Unknown editor "${choice}". Use one of: ${EDITORS.join(', ')}, or buttons.` }
    }
    if (choice === 'custom') {
      if (rest && !/\{file\}/i.test(rest)) {
        return { text: 'The custom command needs {file} where the file goes, e.g. /open-in-ide custom "C:\\Programs\\Notepad++\\notepad++.exe" -n{line} "{file}"' }
      }
      if (rest) {
        await $.store.set('customCommand', rest)
      }
      const command = await customCommand($, customOption)
      if (!command) {
        return { text: 'Give the command to run, with {file} and optionally {line}, {column} and {folder}, e.g. /open-in-ide custom "C:\\Programs\\Notepad++\\notepad++.exe" -n{line} "{file}"' }
      }
      await $.store.set('editor', 'custom')
      return { text: `Code links now open with: ${command}` }
    }
    await $.store.set('editor', choice)
    return {
      text: choice === 'auto'
        ? 'Code links now open in whichever of Rider, Visual Studio and VS Code is running, else the first installed.'
        : `Code links now open in ${choice}.`,
    }
  })

  // The desktop app does not hand link clicks to mods, and its Markdown cannot hold a button, so each
  // paragraph's code references get a row of buttons right under that paragraph, or all at the reply's end
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    let sections = buttonSections(e.props.text)
    if (!sections.some(s => s.targets.length > 0)) {
      return next(e)
    }
    if ((await placement($, placementOption)) === 'end') {
      sections = [{ text: e.props.text, targets: sections.flatMap(s => s.targets) }]
    }

    const { Box, Button, Markdown } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {sections.map(({ text, targets }, i) => (
          <Box key={`section-${i}`} flexDirection="column">
            <Markdown text={text} />
            {targets.length > 0 ? (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {targets.map(({ label, target }, j) => (
                  <Button
                    key={`open-${i}-${j}`}
                    label={label}
                    onPress={async () => open($, await editor($, option), riderPath, await customCommand($, customOption), target)}
                  />
                ))}
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )
  })
}
