import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { summary } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = process.env.BOT_DIR;
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const token = process.env.CF_AIG_TOKEN;
const ghToken = process.env.BOT_GH_TOKEN;
const setting = name => process.env[`BOT_${meta.mode.toUpperCase()}_${name}`];

// Modes that run code get a sandbox and more time.
const MINUTES = { review: 15, triage: 15, ask: 15, investigate: 45, pr: 75 };
const executes = meta.mode === 'investigate' || meta.mode === 'pr';
const SANDBOX_USER = 'wbg-sandbox';
const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
const sandboxRepo = `${SANDBOX_HOME}/work/repo`;

const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : '');
const promptFile = name => readFileSync(join(root, 'prompts', `${name}.md`), 'utf8').trim();
// Questions on PRs see what a review sees, and on issues what triage sees.
const name = meta.mode === 'ask' ? (meta.headSha ? 'ask-pr' : 'ask-issue') : (meta.prompt ?? meta.mode);
let prompt = promptFile(name)
  .replace(/\{\{include:([a-z-]+)\}\}/g, (_, name) => promptFile(name))
  .replaceAll('{{repo}}', meta.repo)
  .replaceAll('{{number}}', String(meta.number));
const guide = read(join(dir, 'guide.md'));
if (guide) prompt += `\n\n## Repository guide (from the base branch)\n\n${guide}\n`;
const request = read(join(dir, 'request.md'));
if (request) prompt += `\n\n## Maintainer request\n\n${request}\n`;

const schema = readFileSync(join(root, 'schemas', `${meta.mode === 'ask' ? 'ask' : name}.json`), 'utf8');
const redact = s => String(s).split(token).join('***').split(ghToken).join('***');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}: ${redact(r.stderr)}`);
  }
  return r.stdout;
}

// Runs a command as the sandbox user with a clean environment.
const asSandbox = (cmd, opts = {}) =>
  run(
    'sudo',
    ['-u', SANDBOX_USER, '-H', 'env', '-i', `PATH=${SANDBOX_HOME}/.cargo/bin:${process.env.PATH}`, `HOME=${SANDBOX_HOME}`, ...cmd],
    { cwd: '/', ...opts }
  );

// Starts a helper that prints its port once listening.
async function serve(script, args, env) {
  const child = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for await (const line of createInterface({ input: child.stdout })) return { child, port: line.trim() };
  throw new Error(`${script} exited before listening`);
}

const args = [
  '-p', prompt,
  '--bare',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--permission-mode', 'dontAsk',
  '--model', setting('MODEL'),
  '--effort', setting('EFFORT'),
  '--max-budget-usd', setting('BUDGET'),
  '--output-format', 'json',
  '--json-schema', schema,
];
const spawnOpts = {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  timeout: MINUTES[meta.mode] * 60 * 1000,
};

let proc;
if (!executes) {
  // The model only gets read tools confined to its cwd plus read-only GitHub
  // access, and the environment is rebuilt from scratch so no tokens reach it.
  // --bare skips hooks and settings, which the PR checkout could otherwise
  // supply. The GitHub tool's config holds the read-only token, so it lives
  // outside the model's working directory.
  const mcpConfig = join(mkdtempSync(join(tmpdir(), 'bot-mcp-')), 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        github: {
          type: 'stdio',
          command: process.execPath,
          args: [join(root, 'scripts', 'github-mcp.mjs')],
          env: { GH_TOKEN: ghToken },
        },
      },
    })
  );
  proc = spawnSync(
    'claude',
    [...args, '--mcp-config', mcpConfig, '--allowedTools', 'mcp__github__get', '--tools', 'Read,Grep,Glob'],
    {
      ...spawnOpts,
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: mkdtempSync(join(tmpdir(), 'claude-home-')),
        ANTHROPIC_BASE_URL: `https://gateway.ai.cloudflare.com/v1/${process.env.CF_ACCOUNT_ID}/${process.env.CF_GATEWAY_ID}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_CUSTOM_HEADERS: `cf-aig-authorization: Bearer ${token}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    }
  );
} else {
  // Running code from an issue means running whatever its author wrote. The
  // model and everything it runs are confined to an unprivileged user with no
  // sudo, while the gateway and GitHub tokens stay in helper processes of the
  // runner user, which that user can't inspect. The helpers listen on
  // localhost and add the tokens to requests themselves.
  const work = `${SANDBOX_HOME}/work`;
  run('sudo', ['useradd', '--create-home', '--shell', '/bin/bash', SANDBOX_USER]);
  run('sudo', ['mkdir', '-p', work]);
  run('sudo', ['cp', '-a', join(dir, 'ctx'), join(dir, 'repo'), work]);
  run('sudo', ['chown', '-R', `${SANDBOX_USER}:${SANDBOX_USER}`, work]);
  console.log('Installing Rust for the sandbox user');
  asSandbox([
    'sh', '-c',
    'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -c clippy,rustfmt',
  ]);

  const gateway = await serve('gateway-proxy.mjs', [], {
    CF_AIG_TOKEN: token,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_GATEWAY_ID: process.env.CF_GATEWAY_ID,
  });
  const github = await serve('github-mcp.mjs', ['--http'], { GH_TOKEN: ghToken });

  const mcpConfig = `${SANDBOX_HOME}/mcp.json`;
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { github: { type: 'http', url: `http://127.0.0.1:${github.port}/` } } })
  );
  run('sudo', ['install', '-o', SANDBOX_USER, '-m', '644', join(dir, 'mcp.json'), mcpConfig]);

  proc = spawnSync(
    'sudo',
    [
      '-u', SANDBOX_USER, '-H', 'env', '-i',
      `PATH=${SANDBOX_HOME}/.cargo/bin:${process.env.PATH}`,
      `HOME=${SANDBOX_HOME}`,
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${gateway.port}`,
      'ANTHROPIC_AUTH_TOKEN=sandbox',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'CARGO_TERM_COLOR=never',
      'bash', '-c', 'cd "$0" && exec "$@"', work,
      'claude',
      ...args,
      '--mcp-config', mcpConfig,
      '--allowedTools', 'mcp__github__get,Bash,Edit,Write',
      '--tools', 'Read,Grep,Glob,Bash,Edit,Write',
    ],
    { ...spawnOpts, cwd: '/' }
  );
  gateway.child.kill();
  github.child.kill();
}

let out;
try {
  out = JSON.parse(proc.stdout);
  if (Array.isArray(out)) out = out.findLast(m => m.type === 'result');
} catch {
  console.error(redact(proc.stderr));
  throw new Error(`claude exited ${proc.status}${proc.error ? `: ${proc.error.message}` : ''}`);
}

const cost = out.total_cost_usd?.toFixed(2);
console.log(`subtype=${out.subtype} turns=${out.num_turns} cost=$${cost}`);
if (out.permission_denials?.length) {
  console.log('Denied tool calls:', JSON.stringify(out.permission_denials, null, 2));
}
summary(`**${meta.mode}** of #${meta.number}: ${out.subtype}, ${out.num_turns} turns, $${cost}`);
if (out.is_error || !out.structured_output) {
  throw new Error(`no structured output: ${redact(out.result)}`);
}

const extra = meta.mode === 'pr' ? collectChanges() : {};
const result = JSON.stringify({ ...meta, ...extra, output: out.structured_output });
if (result.includes(token) || result.includes(ghToken)) throw new Error('output contains a token');
writeFileSync(join(dir, 'result.json'), result);

// Reads the files the model changed relative to the checked-out commit. Only
// the pristine checkout is trusted by git running as the runner user, since
// the sandbox's repository config could run commands, and the sandbox's
// files are read as the sandbox user so symlinks can't reach anything else.
function collectChanges() {
  const pristine = join(dir, 'repo');
  const baseSha = run('git', ['-C', pristine, 'rev-parse', 'HEAD']).trim();
  const names = asSandbox([
    'sh', '-c', 'cd "$0" && git add -A && git diff --cached --name-only -z --no-renames "$1"',
    sandboxRepo, baseSha,
  ])
    .split('\0')
    .filter(Boolean);

  const MAX_FILES = 200;
  const MAX_TOTAL = 10 * 1024 * 1024;
  const valid = name =>
    !name.startsWith('/') &&
    !name.split('/').some(s => s === '..' || s === '' || s === '.git') &&
    // The app can't push workflow changes.
    !name.startsWith('.github/workflows/');
  const dropped = names.filter(n => !valid(n));
  const paths = names.filter(valid).slice(0, MAX_FILES);
  if (dropped.length) console.log(`Dropped changes: ${dropped.join(', ')}`);

  const out = mkdtempSync(join(tmpdir(), 'bot-changes-'));
  if (paths.length) {
    const tar = asSandbox(
      ['tar', '-C', sandboxRepo, '--ignore-failed-read', '--no-recursion', '-cf', '-', '--', ...paths],
      { encoding: null, maxBuffer: 2 * MAX_TOTAL }
    );
    run('tar', ['-C', out, '-xf', '-'], { input: tar, encoding: null });
  }

  const files = [];
  let total = 0;
  for (const path of paths) {
    const local = join(out, path);
    if (!existsSync(local)) {
      const tracked = spawnSync('git', ['-C', pristine, 'cat-file', '-e', `${baseSha}:${path}`]);
      if (tracked.status === 0) files.push({ path, deleted: true });
      continue;
    }
    const st = lstatSync(local);
    if (!st.isFile()) {
      console.log(`Dropped non-regular file ${path}`);
      continue;
    }
    total += st.size;
    if (total > MAX_TOTAL) throw new Error('changes are too large');
    files.push({
      path,
      mode: st.mode & 0o111 ? '100755' : '100644',
      content: readFileSync(local).toString('base64'),
    });
  }
  console.log(`Changed files: ${files.map(f => f.path).join(', ') || '(none)'}`);
  return { baseSha, files };
}
