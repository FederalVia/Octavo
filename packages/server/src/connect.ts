/**
 * Setup snippets for every AI tool that speaks MCP: Claude Code, Claude Desktop, Codex CLI, Cursor, Windsurf,
 * Gemini CLI, VS Code (Copilot), ChatGPT and anything else. One source for the desktop app's Settings → Connect
 * an AI, the web app, and `octavo connect`.
 *
 * Two ways in: stdio (the tool starts `octavo mcp` itself; nothing else needs to run) and HTTP (the tool
 * connects to a running Octavo's /mcp). Both work at the same time on the same vault.
 */

export interface StdioCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ConnectInfo {
  /** Server name the tool shows, e.g. "octavo" or "octavo-work". */
  name: string;
  /** How a tool on this computer can start the MCP server itself (absent when only HTTP makes sense, e.g. Docker). */
  stdio?: StdioCommand;
  /** This Octavo's MCP endpoint, e.g. http://127.0.0.1:4321/mcp. */
  httpUrl: string;
  /** The access key the HTTP endpoint needs, if any. */
  token?: string;
}

export interface ConnectSnippet {
  /** Something to run in a terminal (`command`) or to put in a config file (`file`). */
  kind: 'command' | 'file' | 'note';
  title: string;
  /** For `file`: where the file lives. */
  file?: string;
  text: string;
}

export interface ConnectClient {
  id: string;
  label: string;
  /** Short, user-facing. */
  about: string;
  snippets: ConnectSnippet[];
}

const sh = (s: string) => (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const toml = (s: string) => JSON.stringify(s); // TOML basic strings are JSON-compatible
const json = (v: unknown) => JSON.stringify(v, null, 2);
const shellLine = (c: StdioCommand) => [c.command, ...c.args].map(sh).join(' ');

/** `ELECTRON_RUN_AS_NODE=1 cmd args` for POSIX shells; Windows users get the file form instead. */
function stdioCommandLine(c: StdioCommand): string {
  const env = Object.entries(c.env ?? {})
    .map(([k, v]) => `${k}=${sh(v)}`)
    .join(' ');
  return `${env ? env + ' ' : ''}${shellLine(c)}`;
}

export function connectClients(info: ConnectInfo): ConnectClient[] {
  const { name, stdio, httpUrl, token } = info;
  const authHeader = token ? { Authorization: `Bearer ${token}` } : undefined;
  const headerFlag = token ? ` --header ${sh(`Authorization: Bearer ${token}`)}` : '';
  const stdioJson = stdio ? { command: stdio.command, args: stdio.args, ...(stdio.env ? { env: stdio.env } : {}) } : undefined;
  const httpNote = 'Works while Octavo is open on this computer. ';
  const stdioNote = stdio ? 'Starts Octavo’s memory server by itself, so this app doesn’t need to be open. ' : '';
  const clients: ConnectClient[] = [];

  clients.push({
    id: 'claude-code',
    label: 'Claude Code',
    about: 'Run one command in a terminal.',
    snippets: [
      ...(stdio
        ? [{ kind: 'command' as const, title: `Local (${stdioNote.trim()})`, text: `claude mcp add ${sh(name)} --scope user${stdio.env ? ` ${Object.entries(stdio.env).map(([k, v]) => `--env ${sh(`${k}=${v}`)}`).join(' ')}` : ''} -- ${shellLine(stdio)}` }]
        : []),
      { kind: 'command', title: `Over HTTP (${httpNote.trim()})`, text: `claude mcp add --transport http ${sh(name)} ${sh(httpUrl)}${headerFlag}` },
    ],
  });

  clients.push({
    id: 'claude-desktop',
    label: 'Claude Desktop',
    about: 'Settings → Developer → Edit Config, then add this under "mcpServers".',
    snippets: stdioJson
      ? [{ kind: 'file', title: 'claude_desktop_config.json', file: 'claude_desktop_config.json', text: json({ mcpServers: { [name]: stdioJson } }) }]
      : [{ kind: 'note', title: 'Claude Desktop', text: 'Claude Desktop starts MCP servers itself and can’t use an HTTP address directly. Run Octavo on the same computer and use the desktop app’s snippet, or add this server through a remote-MCP connector.' }],
  });

  clients.push({
    id: 'codex',
    label: 'Codex CLI (OpenAI)',
    about: 'Run one command, or add a section to ~/.codex/config.toml.',
    snippets: [
      ...(stdio ? [{ kind: 'command' as const, title: 'Local', text: `codex mcp add ${sh(name)}${stdio.env ? ` ${Object.entries(stdio.env).map(([k, v]) => `--env ${sh(`${k}=${v}`)}`).join(' ')}` : ''} -- ${shellLine(stdio)}` }] : []),
      { kind: 'command', title: 'Over HTTP', text: `codex mcp add ${sh(name)} --url ${sh(httpUrl)}${token ? `\n# then add under [mcp_servers.${name}] in ~/.codex/config.toml:\n# http_headers = { Authorization = ${toml(`Bearer ${token}`)} }` : ''}` },
      {
        kind: 'file',
        title: 'Config file',
        file: '~/.codex/config.toml',
        text: stdio
          ? `[mcp_servers.${name}]\ncommand = ${toml(stdio.command)}\nargs = [${stdio.args.map(toml).join(', ')}]${stdio.env ? `\nenv = { ${Object.entries(stdio.env).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }` : ''}`
          : `[mcp_servers.${name}]\nurl = ${toml(httpUrl)}${token ? `\nhttp_headers = { Authorization = ${toml(`Bearer ${token}`)} }` : ''}`,
      },
    ],
  });

  clients.push({
    id: 'cursor',
    label: 'Cursor',
    about: 'Cursor Settings → MCP → Add new server, or edit ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
    snippets: [
      ...(stdioJson ? [{ kind: 'file' as const, title: 'Local', file: '~/.cursor/mcp.json', text: json({ mcpServers: { [name]: stdioJson } }) }] : []),
      { kind: 'file', title: 'Over HTTP', file: '~/.cursor/mcp.json', text: json({ mcpServers: { [name]: { url: httpUrl, ...(authHeader ? { headers: authHeader } : {}) } } }) },
    ],
  });

  clients.push({
    id: 'windsurf',
    label: 'Windsurf',
    about: 'Edit ~/.codeium/windsurf/mcp_config.json (create it if missing).',
    snippets: [
      ...(stdioJson ? [{ kind: 'file' as const, title: 'Local', file: '~/.codeium/windsurf/mcp_config.json', text: json({ mcpServers: { [name]: stdioJson } }) }] : []),
      { kind: 'file', title: 'Over HTTP', file: '~/.codeium/windsurf/mcp_config.json', text: json({ mcpServers: { [name]: { serverUrl: httpUrl, ...(authHeader ? { headers: authHeader } : {}) } } }) },
    ],
  });

  clients.push({
    id: 'gemini',
    label: 'Gemini CLI (Google)',
    about: 'Edit ~/.gemini/settings.json, or run `gemini mcp add`.',
    snippets: [
      ...(stdio ? [{ kind: 'command' as const, title: 'Local', text: `gemini mcp add ${sh(name)}${stdio.env ? ` ${Object.entries(stdio.env).map(([k, v]) => `-e ${sh(`${k}=${v}`)}`).join(' ')}` : ''} ${shellLine(stdio)}` }] : []),
      { kind: 'file', title: 'Over HTTP', file: '~/.gemini/settings.json', text: json({ mcpServers: { [name]: { httpUrl, ...(authHeader ? { headers: authHeader } : {}) } } }) },
    ],
  });

  clients.push({
    id: 'vscode',
    label: 'VS Code (Copilot)',
    about: 'Command palette → "MCP: Add Server", or edit .vscode/mcp.json in a project (or your user mcp.json).',
    snippets: [
      ...(stdioJson ? [{ kind: 'file' as const, title: 'Local', file: '.vscode/mcp.json', text: json({ servers: { [name]: { type: 'stdio', ...stdioJson } } }) }] : []),
      { kind: 'file', title: 'Over HTTP', file: '.vscode/mcp.json', text: json({ servers: { [name]: { type: 'http', url: httpUrl, ...(authHeader ? { headers: authHeader } : {}) } } }) },
    ],
  });

  clients.push({
    id: 'chatgpt',
    label: 'ChatGPT',
    about: 'ChatGPT reaches MCP servers only over the internet (HTTPS), as a connector.',
    snippets: [
      {
        kind: 'note',
        title: 'How',
        text:
          'Turn on Access from Anywhere (⚙ Settings → Use on your phone), then in ChatGPT go to Settings → Connectors → Create (developer mode is needed) and enter your https://… address with /mcp on the end, with the access key as a Bearer token. ChatGPT’s connector support changes often; check OpenAI’s current help page if the option looks different.',
      },
    ],
  });

  clients.push({
    id: 'other',
    label: 'Anything else that speaks MCP',
    about: 'Give the tool either the command or the address below.',
    snippets: [
      ...(stdio ? [{ kind: 'command' as const, title: 'Local command (stdio transport)', text: stdioCommandLine(stdio) }] : []),
      { kind: 'note', title: 'HTTP (Streamable HTTP transport)', text: `${httpUrl}${token ? `\nHeader: Authorization: Bearer ${token}` : '\nNo key needed on this computer.'}` },
    ],
  });

  return clients;
}
