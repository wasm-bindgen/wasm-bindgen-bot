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
const VERBS = { review: 'pr', triage: 'issue', investigate: 'issue', pr: 'any', rebase: 'pr', issue: 'any' };
// Any other comment to the bot is a question, answered read-only.
const LEGACY_LABELS = { 'bot-request-review': 'review', 'bot-issue-triage': 'triage' };

// After a push to the default branch, auto-merge PRs that it left
// conflicting get `bot-rebase`. GitHub computes mergeability lazily, so each
// is polled until it is known.
if (name === 'push') {
  const { default_branch } = await gh(`/repos/${repo}`);
  if (event.ref !== `refs/heads/${default_branch}`) skip('not the default branch');
  const waiting = (await paginate(`/repos/${repo}/pulls?state=open`, 1000)).filter(
    p => p.auto_merge && p.head.repo?.full_name === repo && !p.labels.some(l => l.name === 'bot-rebase')
  );
  const conflicting = [];
  for (const p of waiting) {
    let pr;
    for (let i = 0; i < 12; i++) {
      pr = await gh(`/repos/${repo}/pulls/${p.number}`);
      if (pr.mergeable !== null) break;
      await new Promise(r => setTimeout(r, 5000));
    }
    if (pr.mergeable === false) conflicting.push(p.number);
  }
  if (!conflicting.length) skip('no auto-merge PRs are conflicting');
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ repo, mode: 'flag-conflicts', numbers: conflicting }));
  process.exit(0);
}

// A collaborator's approval of a same-repo PR enables auto-merge. It needs no
// model, so the result goes straight to the post job.
if (name === 'pull_request_review') {
  const { review, pull_request: pr } = event;
  if (review.state !== 'approved') skip('not an approval');
  if (isBot(review.user.login) || !(await isTrusted(review.user.login))) {
    skip(`${review.user.login} is not a collaborator`);
  }
  if (pr.draft || pr.labels.some(l => /do.?not.?land/i.test(l.name))) skip('PR is not ready to land');
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({ repo, number: pr.number, mode: 'automerge', approver: review.user.login })
  );
  process.exit(0);
}

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
    if (mode === 'issue') skip('issue needs a request, in a comment');
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
} else if (name === 'workflow_dispatch') {
  // Run from the Actions tab. Without a number, `pr` works from the request
  // alone.
  const inputs = event.inputs ?? {};
  mode = inputs.command;
  if (!Object.hasOwn(VERBS, mode)) skip(`unknown command ${mode}`);
  requester = event.sender.login;
  if (inputs.request?.trim()) request = `${requester}: ${inputs.request.trim()}`;
  if (mode === 'issue' && !request) skip('issue needs a request');
  if (inputs.number?.trim()) {
    number = Number(inputs.number.trim().replace(/^#/, ''));
    if (!Number.isInteger(number)) skip(`invalid number ${inputs.number}`);
    isPr = !!(await gh(`/repos/${repo}/issues/${number}`)).pull_request;
  } else {
    if (mode !== 'pr' || !request) skip('without a number, only pr with a request is supported');
    number = null;
    isPr = false;
  }
} else {
  skip(`unsupported event ${name}`);
}
if (mode !== 'ask' && VERBS[mode] !== 'any' && (VERBS[mode] === 'pr') !== isPr) {
  skip(`${mode} does not apply to ${isPr ? 'PRs' : 'issues'}`);
}
// The app itself only adds `bot-pr`, after an investigation a collaborator
// requested or a review of its own PR, `bot-review` to its own PRs and to PRs
// whose conflicts it resolved, and `bot-rebase` to auto-merge PRs that a
// merge left conflicting.
const fromApp = isBot(requester) && (mode === 'pr' || mode === 'review' || mode === 'rebase');
if (requester && !fromApp && !(await isTrusted(requester))) skip(`${requester} is not a collaborator`);

const meta = { repo, number, mode, requester, label, ...meta0 };

// A PR stacked on other PRs, through base branches that are their heads, is
// rebased with its whole stack, bottom up, so one request on any layer keeps
// the stack consistent. When a lower layer also has a rebase requested, its
// run covers this one.
if (mode === 'rebase') {
  const open = (await paginate(`/repos/${repo}/pulls?state=open`, 1000)).filter(
    p => p.head.repo?.full_name === repo
  );
  const byHead = new Map(open.map(p => [p.head.ref, p]));
  let pr = open.find(p => p.number === number);
  if (!pr) skip('only open PRs from branches in this repository can be rebased');
  while (byHead.has(pr.base.ref)) {
    pr = byHead.get(pr.base.ref);
    if (pr.labels.some(l => l.name === 'bot-rebase')) skip(`#${pr.number} below it is being rebased with its stack`);
  }
  const stack = [];
  const queue = [{ pr, parent: null }];
  let text = `Base branch: ${pr.base.ref}\n\nLayers, bottom up:\n`;
  while (queue.length) {
    const { pr: p, parent } = queue.shift();
    stack.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, parent });
    text +=
      `\n## #${p.number}: ${p.title}\n\nBranch: ${p.head.ref} @ ${p.head.sha}\n` +
      `Rebase onto: ${parent ? `the rebased ${parent}` : pr.base.ref}\n\n${p.body || '(no description)'}\n`;
    for (const child of open.filter(c => c.base.ref === p.head.ref)) queue.push({ pr: child, parent: p.head.ref });
  }
  Object.assign(meta, { baseRef: pr.base.ref, stack });
  writeFileSync(join(ctx, 'stack.md'), text);
  await writeGuide(pr.base.ref);
  setOutput('checkout-ref', pr.base.ref);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  setOutput('mode', meta.mode);
  process.exit(0);
}

if (number === null) {
  const { default_branch } = await gh(`/repos/${repo}`);
  meta.prompt = 'pr-request';
  meta.baseRef = default_branch;
  await writeGuide(default_branch);
  setOutput('checkout-ref', default_branch);
  writeFileSync(join(dir, 'request.md'), request + '\n');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  setOutput('mode', meta.mode);
  process.exit(0);
}

// Questions and follow-on issues are fine after a PR merges or an issue
// closes.
const followOn = mode === 'ask' || mode === 'issue';
if (isPr) {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' && !followOn) skip('PR is not open');
  // The bot's own pushes, such as rebases, only move the PR onto newer code.
  if (event.action === 'synchronize' && isBot(event.sender?.login)) skip('push by the bot');
  if (event.action === 'synchronize' && !(await isTrusted(pr.user.login))) {
    skip(`pushes by ${pr.user.login} are only re-reviewed on request`);
  }
  meta.headSha = pr.head.sha;
  // Anyone can comment on the bot's own PRs, but only collaborators' and the
  // bot's words reach the runs that work on them, which can push code.
  const botPr = isBot(pr.user.login);
  const heard = async login => !botPr || isBot(login) || (await isTrusted(login));
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
      if (!(await heard(r.user?.login))) continue;
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
      if (!(await heard(t.comments.nodes[0]?.author?.login))) continue;
      const mine = isBot(t.comments.nodes[0]?.author?.login);
      const state = [t.isResolved ? 'resolved' : 'open', t.isOutdated && 'outdated']
        .filter(Boolean)
        .join(', ');
      text +=
        `## ${t.path}:${t.line ?? t.originalLine} (${state})` +
        (t.isResolved ? '' : `\n${mine ? 'Your thread, id' : 'Thread id'}: ${t.id}`) +
        '\n';
      for (const c of t.comments.nodes) {
        if (await heard(c.author?.login)) text += `\n### ${await who(c.author?.login)}\n\n${c.body}\n`;
      }
      text += '\n';
    }
    writeFileSync(join(ctx, 'threads.md'), text);
  }

  const conversation = await paginate(`/repos/${repo}/issues/${number}/comments`, 100);
  if (conversation.length) {
    let text = '';
    for (const c of conversation) {
      if (await heard(c.user.login)) text += `## ${await who(c.user.login)}, ${c.created_at}\n\n${c.body}\n\n`;
    }
    if (text) writeFileSync(join(ctx, 'conversation.md'), text);
  }

  await writeGuide(pr.base.sha);
  setOutput('checkout-ref', pr.head.sha);
} else {
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  if (issue.state !== 'open' && !followOn) skip('issue is not open');
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
    } else if (name === 'workflow_dispatch') {
      cutoff = new Date().toISOString();
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

  const { default_branch } = await gh(`/repos/${repo}`);
  meta.baseRef = default_branch;
  await writeGuide(default_branch);
  setOutput('checkout-ref', default_branch);
}

if (!isPr || followOn) {
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
}

if (request) writeFileSync(join(dir, 'request.md'), request + '\n');
writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
setOutput('mode', meta.mode);
