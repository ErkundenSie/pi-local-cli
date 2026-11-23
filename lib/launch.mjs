import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const windows = process.platform === 'win32';
const home = homedir();
const emptyMcpPath = fileURLToPath(new URL('./empty-mcp.mjs', import.meta.url));

// A Grok agent profile for gateway requests: no built-in tools, and no
// inherited MCP servers, skills or plugins. With caller-declared tools the
// MCP meta-tools stay (they are how the CLI reaches those tools) and the ACP
// client approves only calls that name one of them.
export function gatewayProfile(clientTools) {
  // Current Grok names, plus the older ones a previous build still advertises.
  // search_tool and use_tool stay only when the caller attached tools: they
  // are how that CLI reaches the MCP catalog. A denied shell call aborts the
  // whole turn, so the shell must not be offered in the first place.
  const builtIns = ['read_file', 'search_replace', 'grep_search', 'grep', 'list_dir', 'bash', 'run_terminal_command',
    'web_search', 'web_fetch', 'todo_write', 'task', 'kill_task', 'get_task_output', 'memory_search', 'memory_get',
    'lsp', 'Agent', 'monitor', 'workflow', 'write', 'image_gen', 'image_edit', 'image_to_video', 'reference_to_video',
    'enter_plan_mode', 'exit_plan_mode', 'ask_user_question'];
  if (!clientTools) builtIns.push('search_tool', 'use_tool');
  return `---
name: gateway
description: Text-only local CLI gateway
mainAgent: true
subagent: false
tools: []
inheritMcp: false
inheritCustomizations: false
disallowedTools:
${builtIns.map((tool) => `  - ${tool}`).join('\n')}
---
`;
}

function tomlValue(value) {
  return JSON.stringify(value);
}

// A stdio stand-in replaces a local command server. A remote server is only
// `url`: folding a command into that table leaves the URL in place, and Codex
// rejects the mix (`url is not supported for stdio`). Disabling keeps the URL
// and skips startup. A name this cannot address is refused rather than left exposed.
export function codexMcpOverride(name, server) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Codex has an MCP server named "${name}" that cannot be isolated for a gateway turn. Rename it in config.toml.`);
  }
  if (server && typeof server === 'object' && typeof server.url === 'string' && server.url.trim()) {
    return `mcp_servers.${name}.enabled=false`;
  }
  return `mcp_servers.${name}={command=${tomlValue(process.execPath)},args=${tomlValue([emptyMcpPath])}}`;
}

// An inline TOML table, which is the only shape `-c` accepts for a whole
// entry: JSON's `:` separators would not parse.
function tomlTable(entries) {
  return `{${Object.entries(entries).map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`).join(', ')}}`;
}

const agents = [
  { id: 'codex', label: 'OpenAI Codex', command: 'codex', protocol: 'App Server', hint: 'Install OpenAI Codex, then run codex login.' },
  { id: 'claude', label: 'Claude Code', command: 'claude-agent-acp', protocol: 'ACP', hint: 'Install the native claude executable and @agentclientprotocol/claude-agent-acp. Sign in through Claude Code.' },
  { id: 'antigravity', label: 'Antigravity CLI', command: 'agy', protocol: 'ACP', hint: 'Install Google Antigravity CLI and sign in using agy.' },
  { id: 'grok', label: 'Grok Build', command: 'grok', protocol: 'ACP', hint: 'Install Grok Build and run grok login.' },
];

function readConfig(file, read) {
  try {
    if (statSync(file).size > 4 * 1024 * 1024) throw new Error('Config is too large');
    return read(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {};
    throw new Error(`Could not check settings in ${file}. Check the file and try again.`);
  }
}

function isFile(file, mode = constants.F_OK) {
  try {
    accessSync(file, mode);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function commandDirectories() {
  return [...(process.env.PATH ?? '').split(windows ? ';' : ':'),
    ...(windows ? [process.env.APPDATA && join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Claude Code'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'agy', 'bin')] : ['/opt/homebrew/bin', '/usr/local/bin']),
    join(home, '.local', 'bin'), join(home, '.grok', 'bin'), join(home, '.antigravity', 'bin'),
    join(home, '.claude', 'local'), join(home, '.cargo', 'bin'), join(home, '.volta', 'bin'), join(home, '.bun', 'bin'),
  ].map((dir) => dir?.trim().replace(/^"|"$/g, '')).filter((dir) => dir && isAbsolute(dir));
}

function codexDesktop() {
  const apps = process.env.ProgramFiles && join(process.env.ProgramFiles, 'WindowsApps');
  if (!apps) return [];
  try {
    return readdirSync(apps).filter((name) => /^OpenAI\.Codex_[\d.]+_(x64|arm64)__[a-z0-9]+$/i.test(name))
      .sort((first, second) => second.localeCompare(first, undefined, { numeric: true }))
      .map((name) => join(apps, name, 'app', 'resources', 'codex.exe'));
  } catch {
    return [];
  }
}

// Use the JS target of a standard npm Windows shim without invoking cmd.exe.
function npmLaunch(file) {
  const shim = readFileSync(file, 'utf8');
  const match = shim.match(/"%dp0%[\\/]?(node_modules[\\/][^"\r\n]+\.(?:cjs|mjs|js))"\s+%\*\s*$/im);
  if (!match) return null;
  const dir = dirname(file);
  const relative = match[1];
  if (relative.split(/[\\/]/).includes('..')) return null;
  const target = join(dir, relative);
  const node = [dir, ...commandDirectories()].map((root) => join(root, 'node.exe')).find((candidate) => isFile(candidate));
  return node && isFile(target) ? { file: node, args: [target] } : null;
}

function resolveCommand(command, override, nativeOnly = false) {
  if (override !== undefined) {
    // `{ "path": …, "args": [...] }` runs a program that needs arguments, such
    // as a script under a runtime the machine already has.
    const extra = override && typeof override === 'object' ? override : undefined;
    const path = extra ? extra.path : override;
    if (typeof path !== 'string' || !isAbsolute(path) ||
        (extra?.args !== undefined && (!Array.isArray(extra.args) || !extra.args.every((arg) => typeof arg === 'string')))) {
      throw new Error(`Use an absolute executable path for ${command} in .local-agents.json.`);
    }
    if (windows && !/\.exe$/i.test(path)) {
      const shim = !nativeOnly && /\.cmd$/i.test(path) && !extra?.args?.length && isFile(path) && npmLaunch(path);
      if (shim) return shim;
      throw new Error(`Configure an .exe (or a supported npm .cmd shim) for ${command}.`);
    }
    if (nativeOnly && extra?.args?.length) throw new Error(`Configure the native ${command} executable without prefix arguments.`);
    if (!isFile(path, windows ? constants.F_OK : constants.X_OK)) {
      throw new Error(`The configured ${command} executable does not exist.`);
    }
    return { file: path, args: [...(extra?.args ?? [])] };
  }
  const directories = commandDirectories();
  const candidates = windows ? [
    ...directories.filter((dir) => !dir.toLowerCase().endsWith('microsoft\\windowsapps'))
      .flatMap((dir) => [join(dir, `${command}.exe`), join(dir, `${command}.cmd`)]),
    ...(command === 'codex' ? codexDesktop() : []),
  ] : directories.map((dir) => join(dir, command));
  for (const candidate of candidates) {
    if (!isFile(candidate, windows ? constants.F_OK : constants.X_OK)) continue;
    if (!windows || /\.exe$/i.test(candidate)) return { file: candidate, args: [] };
    if (!nativeOnly && /\.cmd$/i.test(candidate)) {
      const launch = npmLaunch(candidate);
      if (launch) return launch;
    }
  }
  return null;
}

function configuration(root) {
  const file = process.env.PI_LOCAL_CLI_CONFIG || join(root, '.local-agents.json');
  if (!isAbsolute(file)) throw new Error('PI_LOCAL_CLI_CONFIG must be an absolute file path.');
  const config = readConfig(file, JSON.parse);
  const executables = config?.executables === undefined ? {} : config.executables;
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      !executables || typeof executables !== 'object' || Array.isArray(executables)) {
    throw new Error('Expected an executables object in the Local CLI configuration.');
  }
  return executables;
}

function resolveAgent(agent, executables) {
  if (agent.id === 'claude') {
    const claude = resolveCommand('claude', executables.claude, true);
    const adapter = resolveCommand(agent.command, executables.claudeAdapter);
    return claude && adapter ? { ...adapter, claude: claude.file } : null;
  }
  return resolveCommand(agent.command, executables[agent.id]);
}

export function listAgents(root) {
  let executables;
  let settingsError;
  try { executables = configuration(root); } catch (error) { settingsError = error.message; }
  return agents.map(({ id, label, protocol, hint, command }) => {
    try {
      if (settingsError) throw new Error(settingsError);
      return { id, label, protocol, available: Boolean(resolveAgent({ id, command }, executables)), hint };
    } catch (error) {
      return { id, label, protocol, available: false, hint: error.message };
    }
  });
}

export function workspace(path) {
  if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path) || path.includes('\0')) {
    throw new Error('Enter an absolute path to an existing workspace.');
  }
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch { /* Give invalid paths the same message. */ }
  throw new Error('The workspace directory does not exist or cannot be opened.');
}

function routeIsDirect(value, hosts) {
  if (value === undefined || value === null || value === '') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

const claudeRouting = {
  ANTHROPIC_BASE_URL: ['api.anthropic.com'],
  CLAUDE_CODE_USE_BEDROCK: [], CLAUDE_CODE_USE_VERTEX: [], CLAUDE_CODE_USE_FOUNDRY: [],
};
const googleRouting = {
  GOOGLE_GEMINI_BASE_URL: ['generativelanguage.googleapis.com'],
  GOOGLE_VERTEX_BASE_URL: ['aiplatform.googleapis.com'],
  GOOGLE_CLOUD_CODE_ASSIST_ENDPOINT: ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.sandbox.googleapis.com'],
};
const xaiRouting = {
  XAI_API_BASE_URL: ['api.x.ai'], XAI_BASE_URL: ['api.x.ai'],
  GROK_WS_URL: [], GROK_WS_ORIGIN: [], CLI_CHAT_PROXY_BASE_URL: [],
};

function checkOverrides(settings, routes, where) {
  for (const [key, hosts] of Object.entries(routes)) {
    const value = settings?.[key];
    if (['0', 'false', false].includes(value) && key.startsWith('CLAUDE_CODE_USE_')) continue;
    if (!routeIsDirect(value, hosts)) {
      throw new Error(`Custom inference route ${key} in ${where}. Switch this CLI to its native vendor settings to start a session.`);
    }
  }
}

function parentDirectories(cwd) {
  const directories = [cwd];
  while (directories.at(-1) !== parse(cwd).root) directories.push(dirname(directories.at(-1)));
  return directories;
}

function checkClaude(cwd, env) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const managed = windows ? (env.ProgramFiles && join(env.ProgramFiles, 'ClaudeCode')) :
    (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code');
  const files = [join(configDir, 'settings.json'),
    ...parentDirectories(cwd).flatMap((dir) => ['settings.json', 'settings.local.json'].map((name) => join(dir, '.claude', name))),
    ...(managed ? [join(managed, 'managed-settings.json')] : []),
  ];
  checkOverrides(env, claudeRouting, 'process environment');
  for (const file of new Set(files)) checkOverrides(readConfig(file, JSON.parse)?.env, claudeRouting, file);
}

function envEntries(text) {
  const values = {};
  for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/gim)) {
    const [, name, raw] = match;
    const value = raw.trim().replace(/\s+#.*$/, '').replace(/^(["'])(.*)\1$/, '$2');
    values[name.toUpperCase()] = value;
  }
  return values;
}

function checkGoogle(cwd, env) {
  const configDir = env.GEMINI_CLI_HOME ? join(env.GEMINI_CLI_HOME, '.gemini') : join(home, '.gemini');
  const locations = [join(configDir, '.env'), join(home, '.env'),
    ...parentDirectories(cwd).flatMap((dir) => [join(dir, '.env'), join(dir, '.gemini', '.env')]),
  ];
  checkOverrides(env, googleRouting, 'process environment');
  for (const file of new Set(locations)) checkOverrides(readConfig(file, envEntries), googleRouting, file);
  // Magpie's agy shell function uses a separate settings file. Launching the
  // executable directly skips the shell function and its injected settings.
  const agySettings = join(configDir, 'antigravity-cli', 'settings.json');
  const settings = readConfig(agySettings, JSON.parse);
  if (String(settings?.model ?? '').startsWith('magpie/') || settings?.gateway?.enabled === true) {
    throw new Error(`Custom inference route in ${agySettings}. Choose a native Google model first.`);
  }
}

function checkGrok(cwd, env) {
  checkOverrides(env, xaiRouting, 'process environment');
  const files = [join(env.GROK_HOME || join(home, '.grok'), 'config.toml'),
    ...parentDirectories(cwd).map((dir) => join(dir, '.grok', 'config.toml'))];
  const documents = [...new Set(files)].map((file) => [file, readConfig(file, parseToml)]);
  const defaults = new Set(documents.map(([, config]) => config?.models?.default).filter(Boolean));
  for (const [file, config] of documents) {
    const custom = [...defaults].some((model) => !routeIsDirect(config?.model?.[model]?.base_url, ['api.x.ai']));
    if (String(config?.models?.default ?? '').startsWith('magpie/') || custom ||
        !routeIsDirect(config?.cli_chat_proxy_base_url, ['grok.com', 'api.x.ai']) ||
        !routeIsDirect(config?.xai_api_base_url, ['api.x.ai'])) {
      throw new Error(`Custom inference route in ${file}. Choose a native Grok model first.`);
    }
  }
}

export const agyQuotaArgs = ['--print', '/usage', '--output-format', 'json', '--print-timeout', '8s'];

export function quotaExecutable(root, id) {
  let executables;
  try { executables = configuration(root); } catch { return undefined; }
  const agent = agents.find((candidate) => candidate.id === id);
  const command = agent && resolveAgent(agent, executables);
  if (!command) return undefined;
  if (id === 'claude') return { file: command.claude, args: ['-p', '/usage', '--output-format', 'json'] };
  if (id === 'grok') return { file: command.file, args: [...command.args, 'usage', '--json'] };
  return undefined;
}

export function launchAgent(root, id, cwd, { gateway = false, clientTools = false, mcpServers = [], catalogOnly = false, quotaOnly = false } = {}) {
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error('Unknown CLI.');
  const command = resolveAgent(agent, configuration(root));
  if (!command) throw new Error(agent.hint);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MAGPIE_|PI_LOCAL_CLI_|NODE_OPTIONS$)/i.test(key)));
  // Windows environment names are case-insensitive, but object lookups are not.
  for (const key of Object.keys(env)) {
    if (windows && !(key.toUpperCase() in env)) env[key.toUpperCase()] = env[key];
  }
  let flags;
  switch (id) {
    case 'codex':
      for (const key of Object.keys(env)) if (/^OPENAI_(?:BASE_URL|API_BASE)$/i.test(key)) delete env[key];
      // An empty override lets Codex choose its ChatGPT or API-key endpoint from the native auth mode.
      flags = ['-c', 'model_provider="openai"', '-c', 'openai_base_url=""',
        '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"'];
      if (gateway) {
        const config = join(env.CODEX_HOME || join(home, '.codex'), 'config.toml');
        const servers = readConfig(config, parseToml)?.mcp_servers ?? {};
        for (const [name, server] of Object.entries(servers)) {
          flags.push('-c', codexMcpOverride(name, server));
        }
        flags.push('-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.hooks=false',
          '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"');
        for (const server of mcpServers) {
          const key = `mcp_servers.${server.name}`;
          const entry = tomlTable({ command: server.command, args: server.args });
          // The caller owns these tools and executes them, so Codex must not
          // ask for an approval this gateway cannot answer.
          flags.push('-c', `${key}=${entry.slice(0, -1)},env=${tomlTable(server.env)},default_tools_approval_mode="approve",startup_timeout_sec=20,tool_timeout_sec=1800}`);
        }
      }
      flags.push('app-server', '--listen', 'stdio://');
      break;
    case 'claude':
      checkClaude(cwd, env);
      env.CLAUDE_CODE_EXECUTABLE = command.claude;
      for (const key of Object.keys(env)) if (key !== 'CLAUDE_CODE_EXECUTABLE' && key.toUpperCase() === 'CLAUDE_CODE_EXECUTABLE') delete env[key];
      flags = [];
      break;
    case 'antigravity': {
      checkGoogle(cwd, env);
      if (quotaOnly) { flags = [...agyQuotaArgs]; break; }
      if (quotaOnly) { flags = [...agyQuotaArgs]; break; }
      if (catalogOnly) { flags = ['models']; break; }
      flags = ['acp'];
      if (gateway) {
        const settings = join(cwd, 'gateway-settings.json');
        const deny = ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'];
        if (!clientTools) deny.push('mcp(*)');
        writeFileSync(settings, JSON.stringify({ toolPermission: 'strict', permissions: { deny } }));
        flags = ['--settings', settings, 'acp', '--disable-telemetry'];
      }
      break;
    }
    case 'grok': {
      checkGrok(cwd, env);
      // `grok agent` drops --tools/--deny (headless-only), so a profile's
      // frontmatter is the only place ACP takes the toolset from.
      flags = ['agent', '--no-leader', 'stdio'];
      if (gateway) {
        const profile = join(cwd, 'gateway-agent.md');
        writeFileSync(profile, gatewayProfile(clientTools));
        flags.splice(1, 0, '--agent-profile', profile);
      }
      break;
    }
  }
  return { file: command.file, args: [...command.args, ...flags], cwd: resolve(cwd), env };
}
