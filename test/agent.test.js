import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Repository } from '../src/repository.js';
import { Tools, runProcess } from '../src/tools.js';
import { Agent } from '../src/agent.js';
import { Provider } from '../src/providers.js';
import { loadConfig } from '../src/config.js';
import { safeText } from '../src/cli.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'op-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(dir, 'ignored.txt'), 'private');
  await writeFile(path.join(dir, '.env'), 'SECRET=hidden');
  await writeFile(path.join(dir, 'main.js'), 'export const answer = 42;\n');
  return { dir, repo: await Repository.open(dir) };
}

test('repository includes untracked code, respects ignore rules, and discovers root', async t => {
  const { dir, repo } = await fixture(t);
  assert.deepEqual(await repo.files(), ['.gitignore', 'main.js']);
  await mkdir(path.join(dir, 'nested'));
  assert.equal((await Repository.open(path.join(dir, 'nested'))).root, repo.root);
  await assert.rejects(repo.read('.env'));
  await assert.rejects(repo.read('ignored.txt'));
  await assert.rejects(repo.resolve('../outside'));
  assert.match(await repo.context(), /main.js/);
});

test('file traversal and external symlinks are rejected', { skip: process.platform === 'win32' ? 'Symlink creation may require administrator privileges' : false }, async t => {
  const { dir, repo } = await fixture(t);
  await symlink(os.tmpdir(), path.join(dir, 'escape'));
  await assert.rejects(repo.resolve('escape/secret.txt', true), /outside/);
  await symlink(path.join(dir, '.env'), path.join(dir, 'alias.txt'));
  await assert.rejects(repo.read('alias.txt'), /allowed/);
  await symlink(path.join(dir, 'ignored.txt'), path.join(dir, 'ignored-alias.txt'));
  await assert.rejects(repo.read('ignored-alias.txt'), /ignored/);
});

test('non-Git fallback excludes dependencies and binary reads fail', async t => {
  const { dir } = await fixture(t);
  await rm(path.join(dir, '.git'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules'));
  await writeFile(path.join(dir, 'node_modules', 'hidden.js'), 'hidden');
  await writeFile(path.join(dir, 'binary'), Buffer.from([0, 1, 2]));
  const repo = await Repository.open(dir);
  assert(!(await repo.files()).some(f => f.includes('node_modules')));
  await assert.rejects(repo.read('binary'), /Binary/);
});

test('search, reads, validation, and permission denials', async t => {
  const { dir, repo } = await fixture(t);
  const tools = new Tools(repo, async () => false);
  assert.match(await tools.call('search', { query: 'answer' }), /main.js/);
  assert.match(await tools.call('read_file', { path: 'main.js' }), /1: export/);
  assert.match(await tools.call('read_file', { path: 42 }), /Invalid type/);
  assert.match(await tools.call('list_files', { offset: -1 }), /Invalid value/);
  assert.match(await tools.call('missing', {}), /Unknown tool/);
  assert.match(await tools.call('edit_file', { path: 'main.js', oldText: '42', newText: '43' }), /denied/);
  assert.match(await tools.call('run_command', { command: 'echo danger', reason: 'test' }), /denied/);
  assert.match(await readFile(path.join(dir, 'main.js'), 'utf8'), /42/);
});

test('exact edits, creation, ambiguous matching and concurrent changes', async t => {
  const { dir, repo } = await fixture(t);
  const tools = new Tools(repo, async () => true);
  assert.match(await tools.call('edit_file', { path: 'main.js', oldText: '42', newText: '43' }), /edited/);
  assert.match(await tools.call('edit_file', { path: 'new.txt', newText: 'abc abc' }), /edited/);
  assert.match(await tools.call('edit_file', { path: 'new.txt', oldText: 'abc', newText: 'def' }), /exactly once/);
  const concurrent = new Tools(repo, async () => { await writeFile(path.join(dir, 'main.js'), 'user edit'); return true; });
  assert.match(await concurrent.call('edit_file', { path: 'main.js', oldText: '43', newText: '44' }), /changed during approval/);
  assert.equal(await readFile(path.join(dir, 'main.js'), 'utf8'), 'user edit');
});

test('command output, failures, caps, timeout and child credential removal', async () => {
  assert.equal((await runProcess(process.execPath, ['-e', 'process.exit(7)'])).exitCode, 7);
  const output = await runProcess(process.execPath, ['-e', 'console.log("a".repeat(30000))']);
  assert.match(output.output, /truncated/);
  assert(output.output.length < 25000);
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 });
  assert.equal(timeout.timedOut, true);
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-test';
  try { assert.equal((await runProcess(process.execPath, ['-e', 'console.log(Boolean(process.env.OPENAI_API_KEY))'])).output.trim(), 'false'); }
  finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; }
});

test('plugins receive JSON literally, require approval, and reject collisions', async t => {
  const { dir, repo } = await fixture(t);
  await writeFile(path.join(dir, 'echo.cjs'), 'process.stdin.pipe(process.stdout)');
  const manifest = { version: 1, tools: [{ name: 'echo_args', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, command: [process.execPath, '${pluginDir}/echo.cjs'] }] };
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  const config = { configDir: dir, plugins: ['plugin.json'] };
  let approvals = 0;
  const tools = new Tools(repo, async () => { approvals++; return true; });
  await tools.loadPlugins(config);
  const result = JSON.parse(await tools.call('echo_args', { text: '$(touch nope); & echo hi' }));
  assert.equal(JSON.parse(result.output).text, '$(touch nope); & echo hi');
  assert.equal(approvals, 1);
  assert.match(await tools.call('echo_args', { text: 7 }), /Invalid type/);
  await assert.rejects(tools.loadPlugins(config), /duplicate/);
  const denied = new Tools(repo, async () => false);
  await denied.loadPlugins(config);
  assert.match(await denied.call('echo_args', { text: 'hello' }), /denied/);
});

test('agent loops through tools, returns results and retains conversation', async t => {
  const { repo } = await fixture(t);
  let calls = 0;
  const outputs = [];
  const provider = { complete: async (system, messages) => {
    assert.match(system, /main.js/);
    if (calls++ === 0) return { content: 'Reading code', calls: [{ id: '1', name: 'read_file', input: { path: 'main.js' } }] };
    assert.match(messages.at(-1).content, /answer = 42/);
    return { content: 'The answer is 42.', calls: [] };
  } };
  const agent = new Agent({ provider, repo, tools: new Tools(repo, async () => false), print: x => outputs.push(x) });
  await agent.ask('Explain this project');
  assert.equal(calls, 2);
  assert.equal(outputs.at(-1), 'The answer is 42.');
  assert.equal(agent.messages.length, 4);
  agent.clear();
  assert.equal(agent.messages.length, 0);
});

test('agent bounds repeated tool execution', async t => {
  const { repo } = await fixture(t);
  const provider = { complete: async () => ({ content: '', calls: [{ id: 'loop', name: 'list_files', input: {} }] }) };
  const agent = new Agent({ provider, repo, tools: new Tools(repo, async () => false), print: () => {}, maxSteps: 2 });
  await assert.rejects(agent.ask('loop'), /Stopped after 2/);
  assert.equal(agent.messages.at(-1).role, 'tool');
});

test('provider adapters serialize tool conversations and parse responses', async t => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: '', calls: [{ id: '1', name: 'read_file', input: { path: 'main.js' } }, { id: '2', name: 'list_files', input: {} }] }, { role: 'tool', id: '1', content: 'code' }, { role: 'tool', id: '2', content: 'files' }];
  for (const provider of ['anthropic', 'openai']) {
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify(provider === 'anthropic' ? { content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: '3', name: 'list_files', input: {} }] } : { choices: [{ message: { content: 'done', tool_calls: [{ id: '3', function: { name: 'list_files', arguments: '{}' } }] } }] }));
    });
    const client = new Provider({ provider, model: 'fixture-model', apiKey: 'synthetic', baseUrl: 'https://example.invalid/v1' });
    const result = await client.complete('system', messages, [{ name: 'list_files', description: 'list', parameters: { type: 'object', properties: {} } }]);
    assert.equal(result.calls[0].name, 'list_files');
    assert.equal(result.content, 'done');
    if (provider === 'anthropic') {
      assert.equal(request.body.messages.at(-1).content.length, 2);
      assert.equal(request.headers['x-api-key'], 'synthetic');
    } else {
      assert.equal(request.body.messages.at(-1).tool_call_id, '2');
      assert.equal(request.body.tools[0].type, 'function');
    }
    t.mock.restoreAll();
  }
});

test('provider failures are actionable and truncated tool calls never execute', async t => {
  const client = new Provider({ provider: 'openai', model: 'fixture', apiKey: 'synthetic', baseUrl: 'https://example.invalid/v1' });
  t.mock.method(globalThis, 'fetch', async () => new Response('secret response', { status: 401 }));
  await assert.rejects(client.complete('', [], []), /401.*API key/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }] })));
  await assert.rejects(client.complete('', [], []), /truncated/);
  await assert.rejects(new Provider({ provider: 'anthropic' }).complete('', [], []), /ANTHROPIC_API_KEY/);
});

test('config overrides, remote transport checks and CLI entry points', async t => {
  const { dir } = await fixture(t);
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ provider: 'openai', model: 'file-model' }));
  assert.equal((await loadConfig(config, { OP_AGENT_MODEL: 'env-model' })).model, 'env-model');
  await assert.rejects(loadConfig(config, { OP_AGENT_BASE_URL: 'http://remote.example/v1' }), /HTTPS/);
  assert.equal((await loadConfig(config, { OP_AGENT_BASE_URL: 'http://localhost:4000/v1' })).provider, 'openai');
  await assert.rejects(loadConfig(path.join(dir, 'missing'), {}));
  const cli = path.resolve('bin/op-agent.js');
  assert.equal(spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout.trim(), '0.1.0');
  const noInput = spawnSync(process.execPath, [cli, '--cwd', dir, '--config', config], { encoding: 'utf8' });
  assert.equal(noInput.status, 1);
  assert.match(noInput.stderr, /Provide a request/);
  assert.equal(safeText('\x1b[31mhello\x07'), '[31mhello');
});


test('approved agent commands run a specific test and stage and commit requested files', async t => {
  const { dir, repo } = await fixture(t);
  await writeFile(path.join(dir, 'example.test.cjs'), "require('node:test')('answer', () => require('node:assert/strict').equal(42, 42));");
  const commands = [
    'node --test example.test.cjs',
    'git status --short',
    'git add -- main.js',
    'git -c user.name=Test -c user.email=test@example.invalid -c commit.gpgsign=false commit -m "Add answer constant"',
  ];
  let index = 0;
  const outputs = [];
  const provider = { complete: async (_, messages) => {
    if (index > 0) assert.equal(JSON.parse(messages.at(-1).content).exitCode, 0);
    if (index === commands.length) return { content: 'Test passed and main.js committed.', calls: [] };
    return { content: '', calls: [{ id: String(index), name: 'run_command', input: { command: commands[index++], reason: 'Requested test and Git workflow' } }] };
  } };
  await new Agent({ provider, repo, tools: new Tools(repo, async () => true), print: x => outputs.push(x) }).ask('Test and commit main.js');
  assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim(), 'Add answer constant');
  assert.equal(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(), 'main.js');
  assert.match(execFileSync('git', ['status', '--short'], { cwd: dir, encoding: 'utf8' }), /example.test.cjs/);
});
