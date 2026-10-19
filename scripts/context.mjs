// Collects the PR or issue into files for the model to read. Everything
// written under ctx/ is untrusted input; guide.md and request.md come from
// the base branch and a maintainer respectively.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gh, graphql, paginate, fileAt, repo, setOutput, isBot, reviewThreads, numberPatch, isTrusted, roleOf } from './lib.mjs';

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

// Marks the cutoff in an investigation's comment for the PR run it starts.
const CUTOFF = /<!-- wbg-bot cutoff: (\S+) -->/;

function skip(reason) {
  console.log(`Skipping: ${reason}`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ skip: reason }));
  process.exit(0);
}

// Every command is either `@wbg-bot <verb>` in a comment or the `bot-<verb>`
// label, from a collaborator, and applies to PRs, issues or both. `pr` opens
// a PR for an issue, or updates one of the bot's own PRs.
const VERBS = { review: 'pr', triage: 'issue', investigate: 'issue', pr: 'any' };
// Any other comment to the bot is a question, answered read-only.
const LEGACY_LABELS = { 'bot-request-review': 'review', 'bot-issue-triage': 'triage' };

let number;
let isPr;
let mode;
let requester;
let label;
let request = '';
const meta0 = {};
if (name === 'pull_request' || name === 'pull_request_target' || name === 'issues') {
  isPr = name !== 'issues';
  number = (isPr ? event.pull_request : event.issue).number;
  if (event.action === 'labeled') {
    label = event.label.name;
    mode = LEGACY_LABELS[label] ?? (label.startsWith('bot-') ? label.slice(4) : null);
    if (mode === 'ask') mode = null;
    if (!Object.hasOwn(VERBS, mode)) skip(`label ${label} is not a bot command`);
    requester = event.sender.login;
  } else {
    mode = isPr ? 'review' : 'triage';
  }
} else if (name === 'issue_comment' || name === 'pull_request_review_comment') {
  const { body, user } = event.comment;
  const m = /^@(?:wasm-bindgen-bot|wbg-bot)\s+([\s\S]+)$/.exec(body.trim());
  if (!m) skip('comment is not to the bot');
  const verb = /^([a-z-]+)\b([\s\S]*)$/.exec(m[1]);
  mode = verb && Object.hasOwn(VERBS, verb[1]) ? verb[1] : 'ask';
  requester = user.login;
  number = (event.issue ?? event.pull_request).number;
  isPr = !!(event.pull_request ?? event.issue.pull_request);
  if (name === 'pull_request_review_comment') meta0.threadComment = event.comment.id;
  request = `${user.login}: ${(mode === 'ask' ? m[1] : verb[2]).trim()}`;
  meta0.commentUrl = event.comment.html_url;
} else {
  skip(`unsupported event ${name}`);
}
if (mode !== 'ask' && VERBS[mode] !== 'any' && (VERBS[mode] === 'pr') !== isPr) {
  skip(`${mode} does not apply to ${isPr ? 'PRs' : 'issues'}`);
}
// The app itself only adds `bot-pr`, after an investigation a collaborator
// requested or a review of its own PR, and `bot-review` to its own PRs.
const fromApp = isBot(requester) && (mode === 'pr' || mode === 'review');
if (requester && !fromApp && !(await isTrusted(requester))) skip(`${requester} is not a collaborator`);

const meta = { repo, number, mode, requester, label, ...meta0 };

if (isPr) {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open') skip('PR is not open');
  if (event.action === 'synchronize' && !(await isTrusted(pr.user.login))) {
    skip(`pushes by ${pr.user.login} are only re-reviewed on request`);
  }
  meta.headSha = pr.head.sha;
  if (meta.threadComment) {
    const thread = (await reviewThreads(number)).find(t =>
      t.comments.nodes.some(c => c.databaseId === meta.threadComment)
    );
    if (!thread) skip('could not find the review thread');
    meta.threadId = thread.id;
    request += `\n\n(Asked in the review thread on ${thread.path}:${thread.line ?? thread.originalLine}, id ${thread.id}.)`;
  }
  if (mode === 'pr') {
    if (!isBot(pr.user.login) || pr.head.repo?.full_name !== repo) skip('pr only updates the bot\'s own PRs');
    meta.prompt = 'pr-update';
    meta.headRef = pr.head.ref;
    const reviews = (await paginate(`/repos/${repo}/pulls/${number}/reviews`)).filter(r => r.body);
    let text = '';
    for (const r of reviews) {
      text += `## ${await who(r.user?.login)}, ${r.state}, ${r.submitted_at}\n\n${r.body}\n\n`;
    }
    if (text) writeFileSync(join(ctx, 'reviews.md'), text);
  }

  writeFileSync(
    join(ctx, 'pr.md'),
    `# ${pr.title}\n\nAuthor: ${await who(pr.user.login)}\n` +
      `Base: ${pr.base.ref}\nHead: ${pr.head.label} @ ${pr.head.sha}\n\n` +
      `## Description\n\n${pr.body || '(none)'}\n`
  );

  const files = await paginate(`/repos/${repo}/pulls/${number}/files`, 3000);
  writeFileSync(join(ctx, 'diff.patch'), toDiff(files));

  const previous = mode === 'review' && (await paginate(`/repos/${repo}/pulls/${number}/reviews`))
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
  let comments = issue.comments
    ? await paginate(`/repos/${repo}/issues/${number}/comments`, 100)
    : [];

  // Investigations and PRs run code, so they only see the issue as it was
  // when a collaborator asked for them: later comments and edits by anyone
  // else are left out. A PR started by an investigation inherits its cutoff
  // from the investigation's comment.
  let omitted = 0;
  if (mode === 'investigate' || mode === 'pr') {
    let cutoff;
    if (name === 'issue_comment') {
      cutoff = event.comment.created_at;
    } else if (isBot(requester)) {
      const marked = comments.findLast(c => isBot(c.user.login) && CUTOFF.test(c.body));
      cutoff = marked && CUTOFF.exec(marked.body)[1];
    } else {
      const events = await paginate(`/repos/${repo}/issues/${number}/events`, 3000);
      cutoff = events.findLast(e => e.event === 'labeled' && e.label?.name === label)?.created_at;
    }
    if (!cutoff) skip('could not tell when this was requested');
    meta.cutoff = cutoff;
    const [owner, repoName] = repo.split('/');
    const { repository } = await graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { issue(number: $number) { lastEditedAt } }
      }`,
      { owner, name: repoName, number }
    );
    const edited = repository.issue.lastEditedAt;
    if (edited && edited > cutoff && !(await isTrusted(issue.user.login))) {
      skip('the issue was edited after this was requested');
    }
    const kept = [];
    for (const c of comments) {
      if (isBot(c.user.login) || (await isTrusted(c.user.login)) || (c.created_at <= cutoff && c.updated_at <= cutoff)) {
        kept.push(c);
      }
    }
    omitted = comments.length - kept.length;
    comments = kept;
  }

  let text =
    `# ${issue.title}\n\nAuthor: ${await who(issue.user.login)}\n` +
    `Labels: ${issue.labels.map(l => l.name).join(', ') || '(none)'}\n\n` +
    `## Body\n\n${issue.body || '(none)'}\n`;
  for (const c of comments) {
    const body = c.body.replace(CUTOFF, '').trim();
    text += `\n## Comment by ${await who(c.user.login)}, ${c.created_at}\n\n${body}\n`;
  }
  if (omitted) text += `\n(${omitted} later comments omitted)\n`;
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

if (request) writeFileSync(join(dir, 'request.md'), request + '\n');
writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
setOutput('mode', meta.mode);
