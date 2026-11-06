const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.local');
fs.mkdirSync(out, { recursive: true });
const binary = path.join(out, process.platform === 'win32' ? 'core-test.exe' : 'core-test');
const build = spawnSync(process.env.CXX || 'g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-O2', '-Iinclude', 'tests/core_test.cpp', '-o', binary], { cwd: root, stdio: 'inherit' });
if (build.error) { console.error(build.error.message); process.exit(1); }
if (build.status !== 0) process.exit(build.status || 1);
const test = spawnSync(binary, [], { cwd: root, stdio: 'inherit' });
if (test.error) { console.error(test.error.message); process.exit(1); }
process.exit(test.status === null ? 1 : test.status);
