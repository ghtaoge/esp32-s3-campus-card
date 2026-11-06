// Inspect public files, or the exact index contents when called by pre-commit.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const staged = process.argv.includes('--staged');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const files = git(staged
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '-z']).split('\0').filter(Boolean);
const privatePath = /(^|\/)(?:\.pio|\.tools|\.local|artifacts|\.vscode|node_modules|__pycache__)(\/|$)|(^|\/)project\.(?:private|local)\.config\.json$|(^|\/)\.env(?:\..+)?$|\.(?:pem|key|p12|pfx|bin|elf|zip|log)$/i;
const rules = [
  ['real WeChat AppID', /\bwx[0-9a-f]{16}\b/i],
  ['personal Windows user path', /[a-z]:[\\/]Users[\\/][^\s\\/]+/i],
  ['device MAC address', /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/i],
  ['email address', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['hard-coded credential', /(?:password|passwd|appsecret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{6,}["']/i]
];
let findings = 0;
for (const file of files) {
  if (privatePath.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') {
    console.error(`${file}: private/generated file must not be committed`);
    findings++;
    continue;
  }
  const content = staged ? git(['show', `:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8');
  if (content.includes('\0')) {
    console.error(`${file}: unexpected binary file; inspect before publishing`);
    findings++;
    continue;
  }
  for (const [label, expression] of rules) {
    if (expression.test(content)) {
      // Never print the matched value: the report itself should not leak credentials.
      console.error(`${file}: review ${label}`);
      findings++;
    }
  }
  if (file === 'miniprogram/project.config.json') {
    if (JSON.parse(content).appid !== 'touristappid') {
      console.error(`${file}: public configuration must use touristappid`);
      findings++;
    }
  }
}
if (findings) {
  console.error(`Public-file check failed: ${findings} finding(s). No sensitive values were printed.`);
  process.exitCode = 1;
} else {
  console.log(`PASS: checked ${files.length} ${staged ? 'staged' : 'public'} files`);
}
