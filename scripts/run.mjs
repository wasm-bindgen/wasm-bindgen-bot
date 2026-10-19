import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summary } from './lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = process.env.BOT_DIR;
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const token = process.env.CF_AIG_TOKEN;

const read = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : '');
let prompt = readFileSync(join(root, 'prompts', `${meta.mode}.md`), 'utf8')
  .replaceAll('{{repo}}', meta.repo)
  .replaceAll('{{number}}', String(meta.number));
const guide = read(join(dir, 'guide.md'));
if (guide) prompt += `\n\n## Repository guide (from maintainers)\n\n${guide}\n`;
const request = read(join(dir, 'request.md'));
if (request) prompt += `\n\n## Maintainer request\n\n${request}\n`;

const schema = readFileSync(join(root, 'schemas', `${meta.mode}.json`), 'utf8');

// The GitHub tool's config holds the read-only token, so it lives outside the
// model's working directory.
const ghToken = process.env.BOT_GH_TOKEN;
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
const redact = s => String(s).split(token).join('***').split(ghToken).join('***');

// The model only gets read tools confined to its cwd plus read-only GitHub
// access, and the environment is rebuilt from scratch so no tokens reach it.
// --bare skips hooks and settings, which the PR checkout could otherwise
// supply.
const proc = spawnSync(
  'claude',
  [
    '-p', prompt,
    '--bare',
    '--strict-mcp-config',
    '--mcp-config', mcpConfig,
    '--allowedTools', 'mcp__github__get',
    '--no-session-persistence',
    '--tools', 'Read,Grep,Glob',
    '--permission-mode', 'dontAsk',
    '--model', process.env.BOT_MODEL,
    '--effort', process.env.BOT_EFFORT,
    '--max-budget-usd', process.env.BOT_BUDGET,
    '--output-format', 'json',
    '--json-schema', schema,
  ],
  {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
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

const result = JSON.stringify({ ...meta, output: out.structured_output });
if (result.includes(token) || result.includes(ghToken)) throw new Error('output contains a token');
writeFileSync(join(dir, 'result.json'), result);
