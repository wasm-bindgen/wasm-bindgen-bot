// Collects the PR or issue into files for the model to read. Everything
// written under ctx/ is untrusted input; guide.md and request.md come from
// the base branch and a maintainer respectively.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, paginate, fileAt, repo, setOutput, isBot, reviewThreads, numberPatch, isTrusted } from './lib.mjs';

const MAX_DIFF = 400_000;

const dir = process.env.BOT_DIR;
const ctx = join(dir, 'ctx');
mkdirSync(ctx, { recursive: true });
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const name = process.env.GITHUB_EVENT_NAME;

function toDiff(files) {
  let diff = '';
  for (const f of files) {
    const from = f.previous_filename || f.filename;
    diff += `diff --git a/${from} b/${f.filename}\n`;
    diff += `status: ${f.status} (+${f.additions} -${f.deletions})\n`;
    diff += f.patch ? `${numberPatch(f.patch)}\n` : '(no patch: binary or too large)\n';
  }
  return diff.length > MAX_DIFF
    ? diff.slice(0, MAX_DIFF) + '\n(diff truncated, read files in ./repo)\n'
    : diff;
}

// The repository's AGENTS.md, plus optional bot-only notes, read from the base
// branch so a PR can't rewrite its own review instructions.
async function writeGuide(ref) {
  const parts = [];
  for (const path of ['AGENTS.md', '.github/bot.md']) {
    const text = await fileAt(path, ref);
    if (text) parts.push(`### ${path}\n\n${text.trim()}`);
  }
  if (parts.length) writeFileSync(join(dir, 'guide.md'), parts.join('\n\n') + '\n');
}

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ skip: reason }));
  process.exit(0);
}

let number;
let request = '';
let isPr;
if (name === 'pull_request' || name === 'pull_request_target') {
  number = event.pull_request.number;
  isPr = true;
} else if (name === 'issues') {
  number = event.issue.number;
  isPr = false;
} else if (name === 'issue_comment') {
  const { body, user } = event.comment;
  const m = /^@wasm-bindgen-bot\s+(review|triage)\b([\s\S]*)$/.exec(body.trim());
  if (!m) skip('comment is not a bot command');
  if (!(await isTrusted(user.login))) skip(`${user.login} is not a collaborator`);
  number = event.issue.number;
  isPr = !!event.issue.pull_request;
  if ((m[1] === 'review') !== isPr) skip(`${m[1]} does not apply here`);
  request = `${user.login}: ${m[2].trim()}`;
} else {
  skip(`unsupported event ${name}`);
}

const meta = { repo, number, mode: isPr ? 'review' : 'triage' };
if (request) writeFileSync(join(dir, 'request.md'), request + '\n');

if (isPr) {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open') skip('PR is not open');
  if (event.action === 'synchronize' && !(await isTrusted(pr.user.login))) {
    skip(`pushes by ${pr.user.login} are only re-reviewed on request`);
  }
  meta.headSha = pr.head.sha;

  writeFileSync(
    join(ctx, 'pr.md'),
    `# ${pr.title}\n\nAuthor: ${pr.user.login}\n` +
      `Base: ${pr.base.ref}\nHead: ${pr.head.label} @ ${pr.head.sha}\n\n` +
      `## Description\n\n${pr.body || '(none)'}\n`
  );

  const files = await paginate(`/repos/${repo}/pulls/${number}/files`, 3000);
  writeFileSync(join(ctx, 'diff.patch'), toDiff(files));

  const previous = (await paginate(`/repos/${repo}/pulls/${number}/reviews`))
    // Thread replies show up as reviews with an empty body.
    .filter(r => isBot(r.user?.login) && r.body)
    .at(-1);
  if (previous) {
    meta.previousSha = previous.commit_id;
    writeFileSync(
      join(ctx, 'previous-review.md'),
      `Reviewed commit: ${previous.commit_id}\nState: ${previous.state}\n\n${previous.body}\n`
    );
    if (previous.commit_id !== pr.head.sha) {
      const res = await gh(`/repos/${repo}/compare/${previous.commit_id}...${pr.head.sha}`, { raw: true });
      // A force push can drop the reviewed commit, leaving only the full diff.
      if (res.ok) {
        const { files: changed = [] } = await res.json();
        writeFileSync(join(ctx, 'changes-since-review.patch'), toDiff(changed));
      }
    }
  }

  const threads = await reviewThreads(number);
  if (threads.length) {
    writeFileSync(
      join(ctx, 'threads.md'),
      threads
        .map(t => {
          const mine = isBot(t.comments.nodes[0]?.author?.login);
          const state = [t.isResolved ? 'resolved' : 'open', t.isOutdated && 'outdated']
            .filter(Boolean)
            .join(', ');
          const head =
            `## ${t.path}:${t.line ?? t.originalLine} (${state})` +
            (mine && !t.isResolved ? `\nYour thread, id: ${t.id}` : '');
          const body = t.comments.nodes
            .map(c => `### ${c.author?.login ?? 'ghost'}\n\n${c.body}`)
            .join('\n\n');
          return `${head}\n\n${body}\n`;
        })
        .join('\n')
    );
  }

  await writeGuide(pr.base.sha);
  setOutput('checkout-ref', pr.head.sha);
} else {
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  if (issue.state !== 'open') skip('issue is not open');
  const comments = issue.comments
    ? await paginate(`/repos/${repo}/issues/${number}/comments`, 30)
    : [];
  writeFileSync(
    join(ctx, 'issue.md'),
    `# ${issue.title}\n\nAuthor: ${issue.user.login}\n` +
      `Labels: ${issue.labels.map(l => l.name).join(', ') || '(none)'}\n\n` +
      `## Body\n\n${issue.body || '(none)'}\n` +
      comments.map(c => `\n## Comment by ${c.user.login}\n\n${c.body}\n`).join('')
  );

  const labels = await paginate(`/repos/${repo}/labels`);
  writeFileSync(
    join(ctx, 'labels.md'),
    labels.map(l => `- ${l.name}${l.description ? `: ${l.description}` : ''}`).join('\n') + '\n'
  );

  const open = await paginate(`/repos/${repo}/issues?state=open`, 1500);
  const closed = await paginate(`/repos/${repo}/issues?state=closed&sort=updated`, 300);
  writeFileSync(
    join(ctx, 'other-issues.txt'),
    [...open, ...closed]
      .filter(i => !i.pull_request && i.number !== number)
      .map(i => `#${i.number} [${i.state}] ${i.title}`)
      .join('\n') + '\n'
  );

  const { default_branch } = await gh(`/repos/${repo}`);
  await writeGuide(default_branch);
  setOutput('checkout-ref', default_branch);
}

writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
setOutput('mode', meta.mode);
