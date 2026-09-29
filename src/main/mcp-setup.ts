import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, basename, dirname } from 'node:path'

export interface McpSetupResult { client?: 'codex' | 'claude'; id: string; status: 'configured' | 'needs-setup' | 'error'; message: string }
interface Server { name: string; enabled?: boolean; transport?: { command?: string; args?: string[]; env?: Record<string, string> } }
interface SetupDependencies {
  readText?(path: string): Promise<string>
  home: string
  env: NodeJS.ProcessEnv
  executable(path: string): Promise<boolean>
  exists(path: string): Promise<boolean>
  run(command: string, args: string[]): Promise<string>
}
const GOOGLE_SPEC = 'git+https://github.com/googleads/google-ads-mcp.git@0b78c0caa6d1dfbd21817487c7e571514c627c87'
const ALLOWED = {
  'chrome-devtools': { name: 'terminai-chrome', executable: 'npx', args: ['-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--no-usage-statistics'], aliases: ['chrome-devtools', 'chrome_devtools', 'chrome'] },
  'google-ads': { name: 'terminai-google-ads', executable: 'pipx', args: ['run', '--spec', GOOGLE_SPEC, 'google-ads-mcp'], aliases: ['google-ads', 'google_ads'] },
} as const

/** Internal dependency seam for offline tests; never expose this factory through IPC. */
export function createMcpSetup(deps: SetupDependencies, client: 'codex' | 'claude' = 'codex') {
  let pending: Promise<unknown> = Promise.resolve()
  const folders = [...new Set([join(deps.home, '.npm-global/bin'), join(deps.home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...(deps.env.PATH || '').split(delimiter).filter(p => p.startsWith('/') && !/[\r\n\0]/.test(p))])]
  async function findExecutable(name: string): Promise<string | null> {
    for (const folder of folders) {
      const path = join(folder, name)
      if (await deps.executable(path)) return path
    }
    return null
  }
  async function supportedNode(path: string): Promise<boolean> {
    try {
      const version = (await deps.run(path, ['--version'])).trim().match(/^v(\d+)\.(\d+)\.(\d+)$/)
      return !!version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 12)
    } catch { return false }
  }
  async function findSupportedNode(): Promise<string | null> {
    for (const folder of folders) {
      const path = join(folder, 'node')
      if (await deps.executable(path) && await supportedNode(path)) return path
    }
    return null
  }
  async function validSavedNodePath(value: string | undefined): Promise<boolean> {
    if (!value) return false
    const directories = value.split(delimiter)
    if (directories.some(p => !p.startsWith('/') || /[\r\n\0]/.test(p))) return false
    // /usr/bin/env node chooses the first executable, not the newest one later in PATH.
    for (const folder of directories) {
      const path = join(folder, 'node')
      if (await deps.executable(path)) return supportedNode(path)
    }
    return false
  }
  async function setup(ids: string[]): Promise<McpSetupResult[]> {
    const requested = [...new Set(ids)].slice(0, 20)
    const results: McpSetupResult[] = []
    const valid = requested.filter(id => Object.hasOwn(ALLOWED, id))
    for (const id of requested.filter(id => !Object.hasOwn(ALLOWED, id))) results.push({ id, status: 'error', message: 'This MCP is not in the supported installation allowlist.' })
    if (!valid.length) return results
    const codex = await findExecutable(client)
    if (!codex) return [...results, ...valid.map(id => ({ id, status: 'needs-setup' as const, message: `Install ${client === 'claude' ? 'Claude Code' : 'the Codex CLI'} and sign in, then retry MCP setup.` }))]
    const readServers = async (): Promise<Server[]> => {
      let value: unknown
      if (client === 'claude') {
        if (!deps.readText) throw Error('Claude configuration reader unavailable')
        let source = '{}'
        try { source = await deps.readText(deps.env.CLAUDE_CONFIG_DIR ? join(deps.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(deps.home, '.claude.json')) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        const parsed = JSON.parse(source)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) throw Error('Invalid Claude MCP settings')
        value = Object.entries(parsed.mcpServers || {}).map(([name, transport]) => ({ name, transport }))
      } else value = JSON.parse(await deps.run(codex, ['mcp', 'list', '--json']))
      if (!Array.isArray(value) || value.some(s => !s || typeof s.name !== 'string')) throw new Error('Invalid MCP listing')
      return value as Server[]
    }
    let servers: Server[]
    try { servers = await readServers() } catch {
      return [...results, ...valid.map(id => ({ id, status: 'error' as const, message: 'Could not inspect Codex MCP settings. Existing configuration was not changed.' }))]
    }
    for (const id of valid) {
      const spec = ALLOWED[id as keyof typeof ALLOWED]
      const credentialsPresent = id !== 'google-ads' || await deps.exists(deps.env.GOOGLE_APPLICATION_CREDENTIALS || join(deps.home, '.config/gcloud/application_default_credentials.json'))
      const credentialsGuide = 'Configure your own Google Application Default Credentials with the Google Ads API scope, enable Google Ads API access, and provide a developer token if your account requires it. See https://github.com/googleads/google-ads-mcp#setup-instructions. No credentials are copied by TerminAI.'
      try {
        const existing = servers.find(s => s.name === spec.name || (spec.aliases as readonly string[]).includes(s.name))
        if (existing) {
          const matchesOwned = existing.name === spec.name
            ? basename(existing.transport?.command || '') === spec.executable && JSON.stringify(existing.transport?.args) === JSON.stringify(spec.args)
            : (existing.transport?.args || []).some(arg => id === 'chrome-devtools' ? /^chrome-devtools-mcp(?:@|$)/.test(arg) : /(?:^|\/)google-ads-mcp(?:\.git|@|$)/.test(arg))
          const runtimeValid = id !== 'chrome-devtools' || existing.name !== spec.name || await validSavedNodePath(existing.transport?.env?.PATH)
          results.push({ id, status: !matchesOwned || !runtimeValid || existing.enabled === false || !credentialsPresent ? 'needs-setup' : 'configured', message: !runtimeValid && matchesOwned ? 'The existing TerminAI Chrome configuration does not select Node.js 22.12 or newer in its PATH. It was preserved; update its PATH in Codex settings and retry.' : !matchesOwned ? 'An existing MCP name contains a different or unrecognized configuration. It was preserved; verify it in Codex settings.' : existing.enabled === false ? 'An existing MCP configuration is disabled. It was preserved; enable it in Codex if you want to use it.' : !credentialsPresent ? `Existing MCP configuration preserved. ${credentialsGuide}` : 'Existing MCP configuration preserved. Restart the Codex session to load it; connection health has not been tested.' })
          continue
        }
        const command = await findExecutable(spec.executable)
        if (!command) {
          results.push({ id, status: 'needs-setup', message: id === 'google-ads' ? 'Install Python and pipx (https://pipx.pypa.io/stable/installation/), then retry setup. Google credentials must be configured on your own computer.' : 'Install Node.js 22 LTS or newer, including npx, then retry setup.' })
          continue
        }
        let runtimePath: string | undefined
        if (id === 'chrome-devtools') {
          const node = await findSupportedNode()
          if (!node) {
            results.push({ id, status: 'needs-setup', message: 'Chrome DevTools MCP needs Node.js 22.12 or newer. Install it and retry.' })
            continue
          }
          runtimePath = [...new Set([dirname(node), ...folders])].join(delimiter)
        }
        // The subprocess receives fixed argv only; never shell commands or copied credential env.
        await deps.run(codex, client === 'claude'
          ? ['mcp', 'add-json', '--scope', 'user', spec.name, JSON.stringify({ type: 'stdio', command, args: spec.args, ...(runtimePath ? { env: { PATH: runtimePath } } : {}) })]
          : ['mcp', 'add', spec.name, ...(runtimePath ? ['--env', `PATH=${runtimePath}`] : []), '--', command, ...spec.args])
        servers = await readServers()
        const saved = servers.find(s => s.name === spec.name)
        if (!saved || saved.enabled === false || saved.transport?.command !== command || JSON.stringify(saved.transport.args) !== JSON.stringify(spec.args) || (runtimePath && saved.transport.env?.PATH !== runtimePath)) throw new Error('Registration not verified')
        results.push({ id, status: credentialsPresent ? 'configured' : 'needs-setup', message: !credentialsPresent ? `MCP command registered. ${credentialsGuide}` : 'MCP command registered. The pinned package installs on first launch; restart Codex to connect. Package startup and account access have not yet been tested.' })
      } catch {
        // CLI output may contain existing environment secrets. Never return it to the renderer/logs.
        results.push({ id, status: 'error', message: 'MCP setup could not be verified. Check Codex MCP settings and local prerequisites, then retry.' })
      }
    }
    // Deliberately do not delete user-level servers on assignment changes. The caller must
    // gate feature access using freshly fetched assignments before every invocation.
    return results
  }
  return (ids: string[]): Promise<McpSetupResult[]> => {
    const task = pending.then(() => setup(ids)).then(rows => rows.map(row => ({ ...row, client, message: client === 'claude' ? row.message.replaceAll('Codex', 'Claude Code') : row.message })))
    pending = task.catch(() => {})
    return task
  }
}

const home = homedir()
const exists = async (path: string) => { try { await access(path, constants.R_OK); return true } catch { return false } }
const executable = async (path: string) => { try { await access(path, constants.X_OK); return true } catch { return false } }
/** Main-process only. Pass IDs fetched from the authenticated assignment service, never renderer-provided commands. */
const setupDependencies: SetupDependencies = {
  home, env: process.env, exists, executable, readText: path => readFile(path, 'utf8'),
  run: (command, args) => new Promise((resolve, reject) => {
    execFile(command, args, { cwd: home, env: { ...process.env, PATH: [join(home, '.npm-global/bin'), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(delimiter) }, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(new Error('MCP command failed')) : resolve(stdout))
  }),
}
const setupCodexMcps = createMcpSetup(setupDependencies)
const setupClaudeMcps = createMcpSetup(setupDependencies, 'claude')
export async function setupAssignedMcps(ids: string[]) {
  return [...await setupCodexMcps(ids), ...await setupClaudeMcps(ids)]
}
