const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const files = ['app.js', ...['src', 'public', 'scripts', 'test'].flatMap(directory => fs.readdirSync(directory).filter(name => /\.(c?js)$/.test(name)).map(name => `${directory}/${name}`))];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax checked ${files.length} JavaScript files`);
