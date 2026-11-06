const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '.local');
fs.mkdirSync(out, { recursive: true });
const executable = path.join(out, process.platform === 'win32' ? 'transport-test.exe' : 'transport-test');
const build = spawnSync(process.env.CXX || 'g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-Iinclude', 'tests/ble_frames_test.cpp', '-o', executable], { cwd: root, stdio: 'inherit' });
if (build.error) { console.error(build.error.message); process.exit(1); }
if (build.status !== 0) process.exit(build.status || 1);
const test = spawnSync(executable, [], { stdio: 'inherit' });
process.exit(test.status === null ? 1 : test.status);
