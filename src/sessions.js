import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, readdir, rename, lstat, chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_SESSION_BYTES = 5 * 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dataDirectory = () => process.env.OP_AGENT_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'op-agent');

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 5000) throw new Error('Session has an invalid or oversized message history.');
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Session contains an invalid message.');
    const keys = Object.keys(message);
    if (message.role === 'tool' && typeof message.id === 'string' && typeof message.content === 'string' && keys.every(key => ['role', 'id', 'content'].includes(key))) continue;
    if (message.role === 'assistant' && typeof message.content === 'string' && (message.calls === undefined || Array.isArray(message.calls))) {
      if (!keys.every(key => ['role', 'content', 'calls'].includes(key))) throw new Error('Session contains an invalid assistant message.');
      for (const call of message.calls || []) {
        if (!call || typeof call.id !== 'string' || typeof call.name !== 'string' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input) ||
            Object.keys(call).some(key => !['id', 'name', 'input'].includes(key))) {
          throw new Error('Session contains an invalid assistant tool call.');
        }
      }
      continue;
    }
    if (message.role === 'user' && typeof message.content === 'string' && keys.every(key => ['role', 'content'].includes(key))) continue;
    throw new Error('Session contains an unsupported message shape.');
  }
}

function validateSession(session, expectedId) {
  const allowed = new Set(['version', 'id', 'root', 'provider', 'model', 'createdAt', 'updatedAt', 'parentId', 'messages']);
  if (!session || session.version !== 1 || session.id !== expectedId || !SESSION_ID.test(session.id) ||
      typeof session.root !== 'string' || typeof session.provider !== 'string' || typeof session.model !== 'string' ||
      !Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt)) ||
      (session.parentId !== null && session.parentId !== undefined && !SESSION_ID.test(session.parentId)) ||
      Object.keys(session).some(key => !allowed.has(key))) {
    throw new Error(`Invalid session metadata for ${expectedId}.`);
  }
  validateMessages(session.messages);
}

export class Sessions {
  constructor(directory = path.join(dataDirectory(), 'sessions')) {
    this.directory = path.resolve(directory);
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session storage must be a real directory, not a symbolic link.');
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
  }

  file(id) {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error('Invalid session ID.');
    return path.join(this.directory, `${id}.json`);
  }

  async create({ root, provider, model, messages = [], parentId = null }) {
    const now = new Date().toISOString();
    const session = { version: 1, id: randomUUID(), root, provider, model, createdAt: now, updatedAt: now, parentId, messages };
    validateSession(session, session.id);
    await this.save(session);
    return session;
  }

  async save(session) {
    validateSession(session, session.id);
    await this.ensureDirectory();
    const target = this.file(session.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const record = { ...session, updatedAt: new Date().toISOString() };
    const content = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(content) > MAX_SESSION_BYTES) throw new Error('Session exceeds the 5 MiB storage limit. Compact or clear its history.');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temporary, target);
      if (process.platform !== 'win32') await chmod(target, 0o600);
    } catch (error) {
      throw new Error(`Could not save session ${session.id}: ${error.message}`);
    } finally {
      await rm(temporary, { force: true });
    }
    session.updatedAt = record.updatedAt;
    return session;
  }

  async load(id, root) {
    await this.ensureDirectory();
    const file = this.file(id);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Session ${id} is not a regular file.`);
    if (info.size > MAX_SESSION_BYTES) throw new Error(`Session ${id} exceeds the 5 MiB storage limit.`);
    let session;
    try { session = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Session ${id} contains invalid JSON.`);
      throw error;
    }
    validateSession(session, id);
    if (root && session.root !== root) throw new Error(`Session ${id} belongs to ${session.root}, not ${root}.`);
    return session;
  }

  async list(root) {
    await this.ensureDirectory();
    const files = (await readdir(this.directory)).filter(file => file.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      const session = await this.load(id);
      if (root && session.root !== root) continue;
      sessions.push({
        id: session.id,
        root: session.root,
        provider: session.provider,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        parentId: session.parentId || null,
        messages: session.messages.length,
      });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async branch(session) {
    return this.create({
      root: session.root,
      provider: session.provider,
      model: session.model,
      messages: structuredClone(session.messages),
      parentId: session.id,
    });
  }
}
