import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfig, configPath } from './config.js';
import { Repository } from './repository.js';
import { Provider } from './providers.js';
import { Tools } from './tools.js';
import { Agent } from './agent.js';

// Render model and file content as text, never terminal control sequences.
export const safeText = value => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const help = `op-agent — your terminal coding assistant

Usage: op-agent [options] [natural language request]

  --cwd <path>       Project directory (default: current directory)
  --config <path>    Explicit user configuration file
  --yes             Approve every command, edit and plugin (trusted automation only)
  --help            Show help
  --version         Show version

Without a request, starts an interactive conversation.
Commands: /help, /files [filter], /tools, /plugin <name> <JSON>, /clear, /exit
Config: ${configPath()}
Provider: OP_AGENT_PROVIDER=anthropic|openai
Keys: ANTHROPIC_API_KEY or OPENAI_API_KEY
Optional: OP_AGENT_MODEL, OP_AGENT_BASE_URL
`;
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    cwd: { type: 'string' }, config: { type: 'string' }, yes: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) return console.log(help);
  if (values.version) return console.log('0.1.0');
  const config = await loadConfig(values.config);
  const repo = await Repository.open(values.cwd || process.cwd());
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readline = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let closed = false;
  readline?.on('close', () => { closed = true; });
  const print = text => console.log(safeText(text));
  const approve = async detail => {
    print(`\n${detail}`);
    if (values.yes) { print('[approved with --yes]'); return true; }
    if (!readline || closed) { print('[denied: interactive approval required; use --yes for trusted automation]'); return false; }
    const answer = await readline.question('Allow? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  };
  try {
    const tools = new Tools(repo, approve);
    await tools.loadPlugins(config);
    const agent = new Agent({ provider: new Provider(config), tools, repo, print });
    if (positionals.length) return await agent.ask(positionals.join(' '));
    if (!interactive) throw new Error('Provide a request as an argument when stdin is not a terminal.');
    print(`op-agent · ${config.provider}/${config.model}\n${repo.root}\nType /help for commands. Commands and edits ${values.yes ? 'are automatically approved (--yes)' : 'require approval'}.`);
    while (!closed) {
      let prompt;
      try { prompt = (await readline.question('\nop> ')).trim(); } catch { break; }
      if (!prompt) continue;
      if (prompt === '/exit' || prompt === '/quit') break;
      try {
        if (prompt === '/help') print(help);
        else if (prompt === '/clear') { agent.clear(); print('Conversation cleared.'); }
        else if (prompt === '/tools') print(tools.definitions().map(t => `${t.name}: ${t.description}`).join('\n'));
        else if (prompt === '/files' || prompt.startsWith('/files ')) print(await tools.call('list_files', { query: prompt.slice(6).trim() }));
        else if (prompt.startsWith('/plugin ')) {
          const match = prompt.match(/^\/plugin\s+(\S+)\s+([\s\S]+)$/);
          if (!match) throw new Error('Usage: /plugin <tool-name> {"argument":"value"}');
          if (['list_files', 'read_file', 'search', 'edit_file', 'run_command'].includes(match[1])) throw new Error('Use /plugin with a configured plugin tool.');
          print(await tools.call(match[1], JSON.parse(match[2])));
        } else if (prompt.startsWith('/')) print('Unknown command. Type /help.');
        else await agent.ask(prompt);
      } catch (error) { print(`Error: ${error.message}`); }
    }
  } finally { readline?.close(); }
}
