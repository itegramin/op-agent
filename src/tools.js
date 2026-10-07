import { spawn } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
const LIMIT = 24000;
const clip = text => text.length > LIMIT ? `${text.slice(0, LIMIT)}\n[output truncated]` : text;
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = description => ({ type: 'string', description });

export function runProcess(command, args, { cwd, input, shell = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Provider credentials do not need to be inherited by project commands/plugins.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    const child = spawn(command, args, { cwd, env, shell, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', truncated = false, timedOut = false;
    const collect = chunk => {
      const text = chunk.toString();
      const remaining = LIMIT - output.length;
      output += text.slice(0, Math.max(0, remaining));
      if (text.length > remaining) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    const stop = () => {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const interrupt = () => stop();
    process.once('SIGINT', interrupt);
    const cleanup = () => { clearTimeout(timer); process.removeListener('SIGINT', interrupt); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => { cleanup(); resolve({ exitCode: code, signal, timedOut, output: output + (truncated ? '\n[output truncated]' : '') }); });
  });
}

export class Tools {
  constructor(repo, approve) {
    this.repo = repo;
    this.approve = approve;
    this.entries = new Map();
    this.add('list_files', 'List project paths, optionally filtered by a case-insensitive substring. Use pagination for large projects.', schema({ query: string('Path substring'), offset: { type: 'integer', minimum: 0 } }, []), async ({ query = '', offset = 0 }) => {
      const files = (await repo.files()).filter(f => f.toLowerCase().includes(query.toLowerCase()));
      return { total: files.length, files: files.slice(offset, offset + 500), nextOffset: offset + 500 < files.length ? offset + 500 : null };
    });
    this.add('read_file', 'Read an indexed text file with line numbers; excludes ignored and common credential files.', schema({ path: string('Project-relative path'), start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, ['path']), async ({ path: file, start = 1, end = start + 199 }) => {
      if (end < start) throw new Error('end must be >= start.');
      const lines = (await repo.read(file)).split('\n');
      return { totalLines: lines.length, content: clip(lines.slice(start - 1, Math.min(end, start + 399)).map((line, i) => `${start + i}: ${line}`).join('\n')) };
    });
    this.add('search', 'Search literal text across indexed text files. Returns up to 100 matching lines.', schema({ query: string('Nonempty literal text'), path: string('Optional path substring') }, ['query']), async ({ query, path: filter = '' }) => {
      if (!query) throw new Error('Search query must be nonempty.');
      const matches = [];
      const files = (await repo.files()).filter(f => f.includes(filter));
      const indexedFiles = new Set(files);
      for (const file of files) {
        let content;
        try { content = await repo.read(file, indexedFiles); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 400) });
          if (matches.length >= 100) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    });
    this.add('run_command', 'Run a shell command in the project after user approval. Discover the project test runner before selecting test commands. Commands use /bin/sh on Unix and cmd.exe on Windows. No interactive stdin.', schema({ command: string('Exact shell command'), reason: string('Why this command is needed') }), async ({ command, reason }) => {
      if (!await this.approve(`Run in ${repo.root}:\n${command}\nReason: ${reason}`)) return { denied: true, message: 'User declined. Do not retry without a new user request.' };
      return runProcess(command, [], { cwd: repo.root, shell: true });
    });
    this.add('edit_file', 'Create a file or replace one exact occurrence after approval. Parent directory must exist. For existing files provide nonempty oldText; for new files omit oldText.', schema({ path: string('Project-relative path'), oldText: string('Exact existing text; must occur once'), newText: string('Replacement or new file contents') }, ['path', 'newText']), async ({ path: file, oldText, newText }) => {
      const absolute = await repo.resolve(file, true);
      let original;
      try { await stat(absolute); original = await repo.read(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (original === undefined && oldText !== undefined) throw new Error('File does not exist; omit oldText to create it.');
      if (original !== undefined && (!oldText || original.split(oldText).length !== 2)) throw new Error('oldText must match exactly once.');
      const replacement = original === undefined ? newText : original.replace(oldText, () => newText);
      if (!await this.approve(`Edit ${file}:\n--- removed\n${oldText || '(new file)'}\n+++ added\n${newText}`)) return { denied: true };
      // Recheck after the prompt so concurrent user edits are never silently overwritten.
      if (await repo.resolve(file, true) !== absolute) throw new Error('File target changed during approval.');
      if (original !== undefined && await readFile(absolute, 'utf8') !== original) throw new Error('File changed during approval. Read it again.');
      await writeFile(absolute, replacement, { flag: original === undefined ? 'wx' : 'w' });
      return { edited: file };
    });
  }
  add(name, description, parameters, execute) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || this.entries.has(name)) throw new Error(`Invalid or duplicate tool: ${name}`);
    this.entries.set(name, { name, description, parameters, execute });
  }
  definitions() { return [...this.entries.values()].map(({ execute, ...definition }) => definition); }
  async call(name, input) {
    try {
      const tool = this.entries.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      validate(input, tool.parameters);
      return clip(JSON.stringify(await tool.execute(input)));
    } catch (error) { return JSON.stringify({ error: error.message }); }
  }
  async loadPlugins(config) {
    if (!Array.isArray(config.plugins)) throw new Error('plugins must be an array of manifest paths.');
    for (const file of config.plugins) {
      const manifestPath = path.resolve(config.configDir, file);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.version !== 1 || !Array.isArray(manifest.tools)) throw new Error(`Invalid plugin manifest: ${file}`);
      for (const tool of manifest.tools) {
        if (!Array.isArray(tool.command) || !tool.command.length || tool.command.some(x => typeof x !== 'string') || typeof tool.description !== 'string') throw new Error(`Invalid plugin command: ${file}`);
        const properties = tool.parameters?.properties;
        if (tool.parameters?.type !== 'object' || !properties || Object.values(properties).some(p => !['string', 'number', 'integer', 'boolean'].includes(p.type))) throw new Error('Plugin parameters must be an object with primitive properties.');
        const command = tool.command.map(arg => arg.replaceAll('${pluginDir}', path.dirname(manifestPath)));
        this.add(tool.name, tool.description, { ...tool.parameters, additionalProperties: false }, async input => {
          if (!await this.approve(`Plugin ${tool.name}\nExecutable and arguments: ${JSON.stringify(command)}\nInput: ${JSON.stringify(input)}\nWorking directory: ${this.repo.root}`)) return { denied: true };
          return runProcess(command[0], command.slice(1), { cwd: this.repo.root, input: JSON.stringify(input) });
        });
      }
    }
  }
}

function validate(value, definition) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be an object.');
  for (const key of definition.required || []) if (!(key in value)) throw new Error(`Missing argument: ${key}`);
  for (const [key, item] of Object.entries(value)) {
    const prop = definition.properties[key];
    if (!prop) throw new Error(`Unknown argument: ${key}`);
    if (prop.type === 'integer' ? !Number.isInteger(item) : typeof item !== prop.type) throw new Error(`Invalid type for ${key}`);
    if (prop.minimum !== undefined && item < prop.minimum) throw new Error(`Invalid value for ${key}`);
    if (prop.enum && !prop.enum.includes(item)) throw new Error(`Invalid choice for ${key}`);
  }
}
