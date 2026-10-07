import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const configPath = () => path.join(homedir(), '.config', 'op-agent', 'config.json');
export async function loadConfig(file, env = process.env) {
  let config = {};
  try { config = JSON.parse(await readFile(file || configPath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || file) throw error; }
  const provider = env.OP_AGENT_PROVIDER || config.provider || 'anthropic';
  if (!['anthropic', 'openai'].includes(provider)) throw new Error('Provider must be anthropic or openai.');
  const baseUrl = env.OP_AGENT_BASE_URL || config.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid API base URL.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote API endpoints require HTTPS.');
  return {
    provider, baseUrl: baseUrl.replace(/\/$/, ''),
    model: env.OP_AGENT_MODEL || config.model || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1'),
    apiKey: provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
    plugins: config.plugins || [],
    configDir: path.dirname(path.resolve(file || configPath())),
  };
}
