import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The unprivileged user that runs code. The warm cargo cache is built and
// restored at these exact paths, since cargo's fingerprints record them.
export const SANDBOX_USER = 'wbg-sandbox';
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
export const sandboxRepo = `${SANDBOX_HOME}/work/repo`;
export const CARGO_TARGET_DIR = `${SANDBOX_HOME}/target`;
// The cache is saved and restored from here, owned by the runner, and moved
// into the sandbox's home, which is on the same filesystem.
export const CACHE_DIR = join(process.env.RUNNER_TEMP ?? tmpdir(), 'wbg-cargo');
const CACHED = [
  ['registry/index', `${SANDBOX_HOME}/.cargo/registry/index`],
  ['registry/cache', `${SANDBOX_HOME}/.cargo/registry/cache`],
  ['git/db', `${SANDBOX_HOME}/.cargo/git/db`],
  ['target', CARGO_TARGET_DIR],
];

export function sudo(args) {
  const r = spawnSync('sudo', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`sudo ${args.slice(0, 3).join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

// Moves a restored cargo cache, if any, into the new sandbox's home.
export function createSandbox() {
  sudo(['useradd', '--create-home', '--shell', '/bin/bash', SANDBOX_USER]);
  sudo(['mkdir', '-p', `${SANDBOX_HOME}/work`]);
  for (const [from, to] of CACHED) {
    if (!existsSync(join(CACHE_DIR, from))) continue;
    sudo(['mkdir', '-p', join(to, '..')]);
    sudo(['mv', join(CACHE_DIR, from), to]);
  }
  sudo(['chown', '-R', `${SANDBOX_USER}:${SANDBOX_USER}`, SANDBOX_HOME]);
}

// Moves the sandbox's cargo cache out for saving.
export function stashCache() {
  for (const [into, from] of CACHED) {
    sudo(['bash', '-c', `[ -e ${from} ] || exit 0; mkdir -p ${join(CACHE_DIR, into, '..')} && mv ${from} ${join(CACHE_DIR, into)}`]);
  }
  sudo(['chown', '-R', `${process.getuid()}:${process.getgid()}`, CACHE_DIR]);
  console.log(sudo(['du', '-sh', CACHE_DIR]).trim());
}

// Hardlinks the runner's toolchain, leaving its files owned by the runner so
// the sandbox can't modify them, and its directories owned by the sandbox so
// it can add targets and components. Falls back to rustup without one.
export function installRust(asSandbox) {
  const home = homedir();
  if (existsSync(join(home, '.rustup')) && existsSync(join(home, '.cargo', 'bin'))) {
    sudo(['mkdir', '-p', `${SANDBOX_HOME}/.cargo`]);
    sudo(['cp', '-al', join(home, '.rustup'), `${SANDBOX_HOME}/.rustup`]);
    sudo(['cp', '-al', join(home, '.cargo', 'bin'), `${SANDBOX_HOME}/.cargo/bin`]);
    sudo(['find', `${SANDBOX_HOME}/.rustup`, `${SANDBOX_HOME}/.cargo`, '-type', 'd',
      '-exec', 'chown', `${SANDBOX_USER}:${SANDBOX_USER}`, '{}', '+']);
    return;
  }
  console.log('Installing Rust for the sandbox user');
  asSandbox([
    'sh', '-c',
    'curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -c clippy,rustfmt',
  ]);
}
