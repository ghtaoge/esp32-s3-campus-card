const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function runCppTest(source, name, includes = ['include']) {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, '.local');
  const temporary = path.join(out, 'compiler-temp');
  fs.mkdirSync(temporary, { recursive: true });
  const binary = path.join(out, name + (process.platform === 'win32' ? '.exe' : ''));
  const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
  const build = spawnSync(process.env.CXX || 'g++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror', '-O2', ...includes.map(item => '-I' + item), source, '-o', binary
  ], { cwd: root, env, stdio: 'inherit' });
  if (build.error) { console.error(build.error.message); process.exit(1); }
  if (build.status !== 0) process.exit(build.status || 1);
  const result = spawnSync(binary, [], { cwd: root, env, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status === null ? 1 : result.status);
};
