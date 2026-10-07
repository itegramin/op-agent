import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const configPath = () => path.join(homedir(), '.config', 'op-agent', 'config.json');
const readConfig = async (file, optional = false) => {
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Configuration must be a JSON object.');
    return config;
  } catch (error) {
    if (error.code === 'ENOENT' && optional) return {};
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    throw error;
  }
};
const validateKeys = (config, file) => {
  const allowed = new Set(['provider', 'model', 'baseUrl', 'plugins']);
  const unknown = Object.keys(config).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown configuration option${unknown.length === 1 ? '' : 's'} in ${file}: ${unknown.join(', ')}`);
  if (config.plugins !== undefined && (!Array.isArray(config.plugins) || config.plugins.some(plugin => typeof plugin !== 'string' || !plugin.trim()))) {
    throw new Error(`plugins in ${file} must be an array of nonempty paths.`);
  }
};
export async function loadConfig(file, env = process.env, projectRoot) {
  const userFile = path.resolve(file || configPath());
  const userConfig = await readConfig(userFile, !file);
  validateKeys(userConfig, userFile);
  const projectFile = projectRoot ? path.join(projectRoot, '.op-agent.json') : null;
  const projectConfig = projectFile ? await readConfig(projectFile, true) : {};
  if (projectFile) validateKeys(projectConfig, projectFile);

  const config = { ...userConfig, ...projectConfig };
  const plugins = [
    ...(userConfig.plugins || []).map(plugin => path.resolve(path.dirname(userFile), plugin)),
    ...(projectConfig.plugins || []).map(plugin => path.resolve(projectRoot, plugin)),
  ];
  const provider = env.OP_AGENT_PROVIDER || config.provider || 'anthropic';
  if (!['anthropic', 'openai'].includes(provider)) throw new Error('Provider must be anthropic or openai.');
  const baseUrl = env.OP_AGENT_BASE_URL || config.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid API base URL.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote API endpoints require HTTPS.');
  const model = env.OP_AGENT_MODEL || config.model || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4.1');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Model must be a nonempty string.');
  return {
    provider, baseUrl: baseUrl.replace(/\/$/, ''),
    model,
    apiKey: provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY,
    plugins: [...new Set(plugins)],
    configDir: path.dirname(userFile),
    projectConfigFile: projectFile,
  };
}
