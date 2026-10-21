// Builds the default branch's dependencies as the sandbox user, at the paths
// sandbox runs use, for a cargo cache those runs restore. Only pushes to the
// default branch run this, so the cache only ever holds merged code's builds.
// A repository can replace the build with `.github/wasm-bindgen-bot-warm.sh`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_HOME, SANDBOX_USER, CARGO_TARGET_DIR, sandboxRepo, sudo, createSandbox, installRust, stashCache } from './sandbox.mjs';

const checkout = join(process.env.BOT_DIR, 'repo');
if (!existsSync(join(checkout, 'Cargo.toml'))) {
  console.log('No Cargo.toml; nothing to warm');
  process.exit(0);
}
const env = [`PATH=${SANDBOX_HOME}/.cargo/bin:${process.env.PATH}`, `HOME=${SANDBOX_HOME}`, `CARGO_TARGET_DIR=${CARGO_TARGET_DIR}`, 'CARGO_TERM_COLOR=never'];
const asSandbox = cmd =>
  spawnSync('sudo', ['-u', SANDBOX_USER, '-H', 'env', '-i', ...env, 'bash', '-c', 'cd "$0" && exec "$@"', sandboxRepo, ...cmd], {
    stdio: 'inherit',
  });

createSandbox();
sudo(['cp', '-a', checkout, sandboxRepo]);
sudo(['chown', '-R', `${SANDBOX_USER}:${SANDBOX_USER}`, sandboxRepo]);
installRust(cmd => asSandbox(cmd));

const script = '.github/wasm-bindgen-bot-warm.sh';
const build = existsSync(join(checkout, script))
  ? asSandbox(['bash', script])
  : asSandbox(['bash', '-c', 'cargo fetch && cargo build --workspace --tests --keep-going']);
// A partial build still caches what it built.
console.log(`warm build exited ${build.status}`);

// Workspace crates rebuild on every change anyway, so only dependencies are
// kept.
const meta = spawnSync('sudo', ['-u', SANDBOX_USER, '-H', 'env', '-i', ...env, 'bash', '-c',
  `cd ${sandboxRepo} && cargo metadata --no-deps --format-version 1`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (meta.status === 0) {
  const names = [...new Set(JSON.parse(meta.stdout).packages.map(p => p.name))];
  asSandbox(['cargo', 'clean', ...names.flatMap(n => ['-p', n])]);
}
sudo(['rm', '-rf', `${CARGO_TARGET_DIR}/debug/incremental`]);
stashCache();
