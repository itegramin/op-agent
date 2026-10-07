import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
const excludedDirs = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '__pycache__', '.next']);
export function excluded(file) {
  const parts = file.split(/[\\/]/);
  const name = parts.at(-1).toLowerCase();
  return parts.some(p => excludedDirs.has(p)) || name === '.env' || name.startsWith('.env.') ||
    /\.(pem|key|p12|pfx)$/.test(name) || /^(id_rsa|id_ed25519|credentials(?:\.json)?|\.npmrc|\.netrc)$/.test(name);
}
export class Repository {
  constructor(root) { this.root = root; }
  static async open(directory) {
    let root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error('Repository path must be a directory.');
    try { root = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim(); } catch {}
    return new Repository(await realpath(root));
  }
  async files() {
    try {
      const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: this.root, maxBuffer: 8 * 1024 * 1024 });
      return [...new Set(stdout.split('\0').filter(f => f && !excluded(f)))].sort();
    } catch (error) {
      // A failed Git index must not silently expose ignored files in a Git repository.
      try { await exec('git', ['rev-parse', '--git-dir'], { cwd: this.root }); }
      catch { return this.walk(); }
      throw new Error(`Cannot list repository files: ${error.message}`);
    }
  }
  async walk(directory = this.root, files = []) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(this.root, absolute);
      if (excluded(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await this.walk(absolute, files);
      else if (entry.isFile()) files.push(relative.split(path.sep).join('/'));
      if (files.length > 50000) throw new Error('Directory exceeds 50,000 files; choose a smaller project or use Git ignore rules.');
    }
    return files.sort();
  }
  async resolve(file, create = false) {
    if (typeof file !== 'string' || !file || excluded(file)) throw new Error('Invalid or excluded path.');
    const absolute = path.resolve(this.root, file);
    const inside = target => target !== this.root && !path.relative(this.root, target).startsWith(`..${path.sep}`) && path.relative(this.root, target) !== '..' && !path.isAbsolute(path.relative(this.root, target));
    if (!inside(absolute)) throw new Error('Path must stay inside the repository.');
    let resolved;
    try { resolved = await realpath(absolute); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      resolved = path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
    }
    if (!inside(resolved) || excluded(path.relative(this.root, resolved))) throw new Error('Path resolves outside the allowed repository files.');
    return resolved;
  }
  async read(file, indexedFiles) {
    indexedFiles ||= new Set(await this.files());
    if (!indexedFiles.has(file)) throw new Error('File is ignored, excluded, or missing.');
    const absolute = await this.resolve(file);
    if (!indexedFiles.has(path.relative(this.root, absolute).split(path.sep).join('/'))) throw new Error('Resolved file is ignored or excluded.');
    if ((await stat(absolute)).size > 256 * 1024) throw new Error('File exceeds 256 KiB.');
    const data = await readFile(absolute);
    if (data.includes(0)) throw new Error('Binary files cannot be read.');
    return data.toString('utf8');
  }
  async context() {
    const files = await this.files();
    let status = 'Git is unavailable or this is not a Git repository.';
    try { status = (await exec('git', ['status', '--short', '--branch'], { cwd: this.root, maxBuffer: 1024 * 1024 })).stdout.slice(0, 6000); } catch {}
    return `Project: ${this.root}\nGit status:\n${status}\nFiles (${files.length}; first 500 shown):\n${files.slice(0, 500).join('\n')}`;
  }
}
