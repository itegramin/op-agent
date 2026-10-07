import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, configPath } from './config.js';
import { Repository } from './repository.js';
import { Provider } from './providers.js';
import { Tools } from './tools.js';
import { Agent } from './agent.js';
import { TerminalUI } from './terminal-ui.js';
import { Sessions } from './sessions.js';

// Render model and file content as text, never terminal control sequences.
export const safeText = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const help = `op-agent — your terminal coding assistant

Usage: op-agent [options] [natural language request]

  --cwd <path>       Project directory (default: current directory)
  --config <path>    Explicit user configuration file
  --resume <id>      Resume a saved conversation
  --branch <id>      Start a new session from a saved conversation
  --list-sessions    List saved conversations for this project
  --yes             Approve every command, edit and plugin (trusted automation only)
  --help            Show help
  --version         Show version

Without a request, starts an interactive conversation.
Commands: /help, /files [filter], /tools, /plugin <name> <JSON>, /sessions, /resume <id>, /branch, /context, /compact, /clear, /exit
Config: ${configPath()}
Provider: OP_AGENT_PROVIDER=anthropic|openai
Keys: ANTHROPIC_API_KEY or OPENAI_API_KEY
Optional: OP_AGENT_MODEL, OP_AGENT_BASE_URL
`;
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    cwd: { type: 'string' }, config: { type: 'string' }, resume: { type: 'string' }, branch: { type: 'string' },
    'list-sessions': { type: 'boolean', default: false }, yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) return console.log(help);
  if (values.version) return console.log('0.1.0');
  const repo = await Repository.open(values.cwd || process.cwd());
  const sessions = new Sessions();
  if (values['list-sessions']) {
    if (positionals.length || values.resume || values.branch) throw new Error('--list-sessions cannot be combined with a request, --resume, or --branch.');
    const saved = await sessions.list(repo.root);
    console.log(saved.length ? saved.map(item => `${item.id}  ${item.updatedAt}  ${item.provider}/${item.model}  ${item.messages} messages`).join('\n') : 'No saved sessions for this project.');
    return;
  }
  if (values.resume && values.branch) throw new Error('Choose either --resume or --branch, not both.');
  const config = await loadConfig(values.config, process.env, repo.root);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!positionals.length && !interactive) throw new Error('Provide a request as an argument when stdin is not a terminal.');
  let activeSession;
  if (values.resume || values.branch) {
    const source = await sessions.load(values.resume || values.branch, repo.root);
    if (source.provider !== config.provider) throw new Error(`Session uses ${source.provider}; current configuration selects ${config.provider}.`);
    activeSession = values.branch ? await sessions.branch(source) : source;
  } else {
    activeSession = await sessions.create({ root: repo.root, provider: config.provider, model: config.model });
  }
  const readline = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let closed = false;
  readline?.on('close', () => { closed = true; });
  const ui = interactive && !positionals.length ? new TerminalUI({ readline, stdout: process.stdout, provider: config.provider, model: config.model, root: repo.root }) : null;
  const print = text => ui ? ui.addMessage('op-agent', safeText(text)) : console.log(safeText(text));
  const approve = async detail => {
    if (ui) ui.addMessage('approval', detail);
    else print(`\n${detail}`);
    if (values.yes) { print('[approved with --yes]'); return true; }
    if (!readline || closed) { print('[denied: interactive approval required; use --yes for trusted automation]'); return false; }
    const answer = ui ? await ui.question('Allow? [y/N] ') : await readline.question('Allow? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  };
  try {
    const tools = new Tools(repo, approve);
    await tools.loadPlugins(config);
    const agent = new Agent({ provider: new Provider(config), tools, repo, print });
    agent.messages = activeSession.messages;
    if (positionals.length) {
      try { return await agent.ask(positionals.join(' ')); }
      finally { activeSession.messages = agent.messages; await sessions.save(activeSession); }
    }
    ui.start();
    ui.addMessage('session', `Session ${activeSession.id}${activeSession.parentId ? ` · branched from ${activeSession.parentId}` : ''}`);
    for (const message of agent.messages) {
      if (message.role === 'user') ui.addMessage('you', message.content);
      else if (message.role === 'assistant') {
        if (message.content) ui.addMessage('op-agent', message.content);
        if (message.calls?.length) ui.addMessage('tools', message.calls.map(call => call.name).join(', '));
      } else if (message.role === 'tool') ui.addMessage('tool result', message.content);
    }
    ui.setStatus(values.yes ? 'Commands and edits are automatically approved (--yes)' : 'Commands and edits require your approval');
    while (!closed) {
      let prompt;
      try { prompt = (await (ui ? ui.question() : readline.question('\nop> '))).trim(); } catch { break; }
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      try {
        ui?.addMessage('you', prompt);
        if (prompt === '/help') print(help);
        else if (prompt === '/clear') { agent.clear(); activeSession.messages = []; ui?.clearMessages(); print('Conversation cleared.'); }
        else if (prompt === '/sessions') {
          const saved = await sessions.list(repo.root);
          print(saved.length ? saved.map(item => `${item.id}  ${item.updatedAt}  ${item.messages} messages`).join('\n') : 'No saved sessions for this project.');
        }
        else if (prompt.startsWith('/resume ')) {
          const id = prompt.slice(8).trim();
          const resumed = await sessions.load(id, repo.root);
          if (resumed.provider !== config.provider) throw new Error(`Session uses ${resumed.provider}; current configuration selects ${config.provider}.`);
          activeSession = resumed;
          agent.messages = activeSession.messages;
          ui?.addMessage('session', `Resumed session ${activeSession.id}`);
        }
        else if (prompt === '/branch') {
          activeSession = await sessions.branch(activeSession);
          agent.messages = activeSession.messages;
          ui?.addMessage('session', `Branched into session ${activeSession.id}`);
        }
        else if (prompt === '/context') {
          const stats = await agent.contextStats();
          print(`History: ${stats.messages} messages, ${stats.historyCharacters} characters\nSystem/project context: ${stats.systemCharacters} characters\nEstimated total: ${stats.estimatedCharacters}/${stats.limitCharacters} characters`);
        }
        else if (prompt === '/compact') {
          const stats = await agent.compact();
          activeSession.messages = agent.messages;
          await sessions.save(activeSession);
          print(`Compacted conversation: ${stats.beforeCharacters} to ${stats.afterCharacters} characters.`);
        }
        else if (prompt === '/tools') print(tools.definitions().map(t => `${t.name}: ${t.description}`).join('\n'));
        else if (prompt === '/files' || prompt.startsWith('/files ')) print(await tools.call('list_files', { query: prompt.slice(6).trim() }));
        else if (prompt.startsWith('/plugin ')) {
          const match = prompt.match(/^\/plugin\s+(\S+)\s+([\s\S]+)$/);
          if (!match) throw new Error('Usage: /plugin <tool-name> {"argument":"value"}');
          if (['list_files', 'read_file', 'search', 'edit_file', 'run_command'].includes(match[1])) throw new Error('Use /plugin with a configured plugin tool.');
          print(await tools.call(match[1], JSON.parse(match[2])));
        } else if (prompt.startsWith('/')) print('Unknown command. Type /help.');
        else {
          ui?.setStatus('Thinking…');
          await agent.ask(prompt);
        }
      } catch (error) { print(`Error: ${error.message}`); }
      finally {
        activeSession.messages = agent.messages;
        await sessions.save(activeSession);
        ui?.setStatus(values.yes ? 'Ready · --yes approves all actions' : 'Ready · actions require your approval');
      }
    }
  } finally { ui?.close(); readline?.close(); }
}
