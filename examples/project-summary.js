import { readFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const options = JSON.parse(input);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
console.log(JSON.stringify({
  name: pkg.name,
  scripts: pkg.scripts || {},
  ...(options.includeDependencies ? { dependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }) } : {}),
}, null, 2));
