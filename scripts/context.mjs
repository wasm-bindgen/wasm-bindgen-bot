// Collects the PR or issue into files for the model to read. Everything
// written under ctx/ is untrusted input; guide.md and request.md come from
// the base branch and a maintainer respectively.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, paginate, fileAt, repo, setOutput, isBot, reviewThreads, numberPatch, isTrusted, roleOf } from './lib.mjs';

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

async function who(login) {
  const role = isBot(login) ? 'this bot' : login && (await roleOf(login));
  return role ? `${login} (${role})` : login ?? 'ghost';
}

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ skip: reason }));
  process.exit(0);
}

// Every command is either `@wbg-bot <verb>` in a comment or the `bot-<verb>`
// label, from a collaborator, and applies to either PRs or issues.
const VERBS = { review: 'pr', triage: 'issue', investigate: 'issue', pr: 'issue' };
const LEGACY_LABELS = { 'bot-request-review': 'review', 'bot-issue-triage': 'triage' };

let number;
let isPr;
let mode;
let requester;
let label;
let request = '';
if (name === 'pull_request' || name === 'pull_request_target' || name === 'issues') {
  isPr = name !== 'issues';
  number = (isPr ? event.pull_request : event.issue).number;
  if (event.action === 'labeled') {
    label = event.label.name;
    mode = LEGACY_LABELS[label] ?? (label.startsWith('bot-') ? label.slice(4) : null);
    if (!Object.hasOwn(VERBS, mode)) skip(`label ${label} is not a bot command`);
    requester = event.sender.login;
  } else {
    mode = isPr ? 'review' : 'triage';
  }
} else if (name === 'issue_comment') {
  const { body, user } = event.comment;
  const m = /^@(?:wasm-bindgen-bot|wbg-bot)\s+([a-z-]+)\b([\s\S]*)$/.exec(body.trim());
  if (!m) skip('comment is not a bot command');
  mode = m[1];
  if (!Object.hasOwn(VERBS, mode)) skip(`unknown command ${mode}`);
  requester = user.login;
  number = event.issue.number;
  isPr = !!event.issue.pull_request;
  request = `${user.login}: ${m[2].trim()}`;
} else {
  skip(`unsupported event ${name}`);
}
if ((VERBS[mode] === 'pr') !== isPr) skip(`${mode} does not apply to ${isPr ? 'PRs' : 'issues'}`);
// The app itself only adds `bot-pr`, after an investigation a collaborator
// requested.
const fromApp = isBot(requester) && mode === 'pr';
if (requester && !fromApp && !(await isTrusted(requester))) skip(`${requester} is not a collaborator`);

const meta = { repo, number, mode, requester, label };
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
    `# ${pr.title}\n\nAuthor: ${await who(pr.user.login)}\n` +
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
    let text = '';
    for (const t of threads) {
      const mine = isBot(t.comments.nodes[0]?.author?.login);
      const state = [t.isResolved ? 'resolved' : 'open', t.isOutdated && 'outdated']
        .filter(Boolean)
        .join(', ');
      text +=
        `## ${t.path}:${t.line ?? t.originalLine} (${state})` +
        (t.isResolved ? '' : `\n${mine ? 'Your thread, id' : 'Thread id'}: ${t.id}`) +
        '\n';
      for (const c of t.comments.nodes) text += `\n### ${await who(c.author?.login)}\n\n${c.body}\n`;
      text += '\n';
    }
    writeFileSync(join(ctx, 'threads.md'), text);
  }

  const conversation = await paginate(`/repos/${repo}/issues/${number}/comments`, 100);
  if (conversation.length) {
    let text = '';
    for (const c of conversation) {
      text += `## ${await who(c.user.login)}, ${c.created_at}\n\n${c.body}\n\n`;
    }
    writeFileSync(join(ctx, 'conversation.md'), text);
  }

  await writeGuide(pr.base.sha);
  setOutput('checkout-ref', pr.head.sha);
} else {
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  if (issue.state !== 'open') skip('issue is not open');
  const comments = issue.comments
    ? await paginate(`/repos/${repo}/issues/${number}/comments`, 100)
    : [];
  let text =
    `# ${issue.title}\n\nAuthor: ${await who(issue.user.login)}\n` +
    `Labels: ${issue.labels.map(l => l.name).join(', ') || '(none)'}\n\n` +
    `## Body\n\n${issue.body || '(none)'}\n`;
  for (const c of comments) {
    text += `\n## Comment by ${await who(c.user.login)}, ${c.created_at}\n\n${c.body}\n`;
  }
  writeFileSync(join(ctx, 'issue.md'), text);

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
  meta.baseRef = default_branch;
  await writeGuide(default_branch);
  setOutput('checkout-ref', default_branch);
}

writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
setOutput('mode', meta.mode);
