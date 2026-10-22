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
// The warm cargo cache is rebuilt at least monthly.
setOutput('cache-epoch', new Date().toISOString().slice(0, 7));

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

// A unified diff of two line arrays with three lines of context, through the
// longest common subsequence.
function lineDiff(x, y) {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const a = x.slice(i, x.length - j);
  const b = y.slice(i, y.length - j);
  let ops;
  if (a.length * b.length > 25_000_000) {
    ops = [...a.map(l => `-${l}`), ...b.map(l => `+${l}`)];
  } else {
    const w = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * w);
    for (let p = a.length - 1; p >= 0; p--) {
      for (let q = b.length - 1; q >= 0; q--) {
        lcs[p * w + q] = a[p] === b[q] ? lcs[(p + 1) * w + q + 1] + 1 : Math.max(lcs[(p + 1) * w + q], lcs[p * w + q + 1]);
      }
    }
    ops = [];
    let p = 0;
    let q = 0;
    while (p < a.length || q < b.length) {
      if (p < a.length && q < b.length && a[p] === b[q]) (ops.push(` ${a[p]}`), p++, q++);
      else if (q < b.length && (p === a.length || lcs[p * w + q + 1] >= lcs[(p + 1) * w + q])) ops.push(`+${b[q++]}`);
      else ops.push(`-${a[p++]}`);
    }
  }
  ops = [...x.slice(0, i).map(l => ` ${l}`), ...ops, ...x.slice(x.length - j).map(l => ` ${l}`)];
  const keep = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some(o => o[0] !== ' '));
  return ops.map((o, k) => (keep[k] ? o : keep[k - 1] ? '...' : null)).filter(o => o !== null).join('\n');
}

// Pins a PR adds to commits of other repositories in the organization, such
// as git dependencies or submodules, go stale when the PR they point into is
// rebased or merges. Each is traced to its current equivalent: the commit
// with the same author and message on the PR that now has it, or the merge
// commit once that PR merged. Workflows are left out, since the app can't
// push them.
const PIN = /(?:github\.com[/:]|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[^\w.-])[^\n]*?\b([0-9a-f]{40})\b/g;
async function stalePins(number, headSha, baseRef) {
  const owner = repo.split('/')[0];
  const files = await paginate(`/repos/${repo}/pulls/${number}/files`, 3000);
  const found = new Map();
  let modules;
  for (const f of files) {
    if (!f.patch || f.filename.startsWith('.github/workflows/')) continue;
    for (const line of f.patch.split('\n').filter(l => l.startsWith('+'))) {
      const sub = /^\+Subproject commit ([0-9a-f]{40})/.exec(line);
      if (sub) {
        modules ??= (await fileAt('.gitmodules', headSha)) ?? '';
        const url = new RegExp(`path = ${f.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n\\s*url = (\\S+)`).exec(modules)?.[1];
        const m = url && /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
        if (m) found.set(`${m[1]}/${m[2]}@${sub[1]}`, { repo: `${m[1]}/${m[2]}`, sha: sub[1], file: f.filename });
        continue;
      }
      for (const m of line.matchAll(PIN)) {
        found.set(`${m[1]}/${m[2]}@${m[3]}`, { repo: `${m[1]}/${m[2]}`, sha: m[3], file: f.filename });
      }
    }
  }
  // Pins the base branch shares aren't the PR's own.
  const base = new Map();
  const stale = [];
  for (const pin of found.values()) {
    if (pin.repo.split('/')[0] !== owner) continue;
    if (!base.has(pin.file)) base.set(pin.file, (await fileAt(pin.file, baseRef)) ?? '');
    if (base.get(pin.file).includes(pin.sha)) continue;
    const next = await currentEquivalent(pin.repo, pin.sha);
    if (next) stale.push({ ...pin, ...next });
  }
  return stale;
}

async function currentEquivalent(target, sha) {
  const res = await gh(`/repos/${target}/commits/${sha}`, { raw: true });
  if (!res.ok) return null;
  const pinned = await res.json();
  const key = c => `${c.commit.author.email}\n${c.commit.message.trim()}`;
  const { default_branch } = await gh(`/repos/${target}`);
  const onMain = await gh(`/repos/${target}/compare/${default_branch}...${sha}`, { raw: true });
  if (onMain.ok && ['behind', 'identical'].includes((await onMain.json()).status)) return null;
  const since = pinned.commit.committer.date;
  const prs = (await paginate(`/repos/${target}/pulls?state=all&sort=updated&direction=desc`, 100)).filter(
    p => p.updated_at >= since && (p.state === 'open' || p.merged_at)
  );
  for (const p of prs) {
    const commits = await paginate(`/repos/${target}/pulls/${p.number}/commits`, 250);
    if (p.state === 'open' && commits.some(c => c.sha === sha)) return null;
    const match = commits.find(c => c.sha === sha || key(c) === key(pinned));
    if (!match) continue;
    const to = p.merged_at ? p.merge_commit_sha : match.sha;
    return to === sha ? null : { to, via: `${target}#${p.number}, ${p.merged_at ? 'merged' : 'rebased'}` };
  }
  return null;
}

// After a rebase, the reviewed commit and the head differ by everything the
// base gained meanwhile. Instead each commit is paired with its counterpart in
// the reviewed history by author and message, and only commits whose changes
// differ, or that are new, are shown. Returns null when the reviewed history
// is gone.
async function rebasedChanges(pr, reviewed) {
  const commits = async (base, head) => {
    const res = await gh(`/repos/${repo}/compare/${base}...${head}?per_page=250`, { raw: true });
    return res.ok ? (await res.json()).commits : null;
  };
  const before = await commits(pr.base.sha, reviewed);
  const after = await commits(pr.base.sha, pr.head.sha);
  if (!before || !after) return null;
  const key = c => `${c.commit.author.email}\n${c.commit.message.trim()}`;
  // Lower layers of a stack, now part of the base branch.
  const inBase = new Set(((await commits(reviewed, pr.base.sha)) ?? []).map(key));
  const subject = c => `${c.sha.slice(0, 9)} ${c.commit.message.split('\n')[0]}`;
  const patches = async sha => {
    const { files = [] } = await gh(`/repos/${repo}/commits/${sha}`);
    return new Map(files.map(f => [f.filename, f.patch ? f.patch.replace(/^@@ .*$/gm, '@@') : `(${f.status}, no patch)`]));
  };

  const olds = new Map();
  for (const c of before) olds.set(key(c), [...(olds.get(key(c)) ?? []), c]);
  const unchanged = [];
  let out = '';
  for (const c of after) {
    const old = olds.get(key(c))?.shift();
    if (!old) {
      const { files = [] } = await gh(`/repos/${repo}/commits/${c.sha}`);
      out += `\n## New: ${subject(c)}\n\n${toDiff(files)}`;
      continue;
    }
    const [a, b] = await Promise.all([patches(old.sha), patches(c.sha)]);
    let changed = '';
    for (const file of new Set([...a.keys(), ...b.keys()])) {
      const x = (a.get(file) ?? '(not changed)').split('\n');
      const y = (b.get(file) ?? '(not changed)').split('\n');
      if (x.join('\n') === y.join('\n')) continue;
      changed += `\n### ${file}\n\n${lineDiff(x, y)}\n`;
    }
    if (changed) out += `\n## Changed: ${subject(old)} -> ${c.sha.slice(0, 9)}\n${changed}`;
    else unchanged.push(subject(c));
  }
  const dropped = [...olds.values()].flat().filter(c => !inBase.has(key(c)));

  let text =
    'The PR was rebased since your last review. This compares its commits before and after the rebase, ' +
    'paired by author and message, and leaves out what the base branch gained meanwhile. For a changed ' +
    'commit, each file shows how the commit\'s own patch changed: the first column marks patch lines ' +
    'removed (-) or added (+) by the rebase, and the rest of the line is the patch line itself.\n';
  if (unchanged.length) text += `\nUnchanged by the rebase:\n${unchanged.map(s => `- ${s}`).join('\n')}\n`;
  if (dropped.length) text += `\nDropped:\n${dropped.map(c => `- ${subject(c)}`).join('\n')}\n`;
  text += out;
  return text.length > MAX_DIFF ? text.slice(0, MAX_DIFF) + '\n(truncated)\n' : text;
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
const VERBS = { review: 'pr', triage: 'any', investigate: 'issue', pr: 'any', rebase: 'pr', issue: 'any' };
// Any other comment to the bot is a question, answered read-only.
const LEGACY_LABELS = { 'bot-request-review': 'review', 'bot-issue-triage': 'triage' };

// After a push to the default branch, auto-merge PRs and the bot's own PRs
// that it left conflicting get `bot-rebase`. GitHub computes mergeability lazily, so each
// is polled until it is known.
// A collaborator whose approval is of the PR's current head, when nobody's
// latest review requests changes. Commits since an approval need approving.
async function headApprover(pr) {
  const latest = new Map();
  for (const r of await paginate(`/repos/${repo}/pulls/${pr.number}/reviews`)) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') latest.set(r.user.login, r);
  }
  if ([...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) return null;
  for (const [login, r] of latest) {
    if (r.state === 'APPROVED' && r.commit_id === pr.head.sha && !isBot(login) && (await isTrusted(login))) return login;
  }
  return null;
}

if (name === 'push') {
  const { default_branch } = await gh(`/repos/${repo}`);
  if (event.ref !== `refs/heads/${default_branch}`) skip('not the default branch');
  setOutput('warm', 'true');
  const open = await paginate(`/repos/${repo}/pulls?state=open`, 1000);
  // Approvals of fork PRs can't trigger auto-merge themselves, since GitHub
  // gives their review runs no secrets, so every push catches them up.
  const automerge = [];
  for (const p of open) {
    if (p.auto_merge || p.draft || !p.labels.some(l => l.name === 'merge-ready')) continue;
    if (p.labels.some(l => /do.?not.?land/i.test(l.name))) continue;
    const approver = await headApprover(p);
    if (approver) automerge.push({ number: p.number, approver, approvedSha: p.head.sha });
  }
  const waiting = open.filter(
    p => (p.auto_merge || isBot(p.user.login)) && p.head.repo?.full_name === repo &&
      !p.labels.some(l => l.name === 'bot-rebase')
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
  if (!conflicting.length && !automerge.length) skip('no PRs to rebase or auto-merge');
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ repo, mode: 'flag-conflicts', numbers: conflicting, automerge }));
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
  if (!pr.labels.some(l => l.name === 'merge-ready')) skip('approved, but not labelled merge-ready');
  if (pr.draft || pr.labels.some(l => /do.?not.?land/i.test(l.name))) skip('PR is not ready to land');
  if (review.commit_id !== pr.head.sha) skip('the approval is of an earlier commit');
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({ repo, number: pr.number, mode: 'automerge', approver: review.user.login, approvedSha: review.commit_id })
  );
  process.exit(0);
}

// A collaborator's approval and the `merge-ready` label together enable
// auto-merge, so adding the label checks for an approval, and removing it
// turns auto-merge off again.
if (name === 'pull_request_target' && /^(un)?labeled$/.test(event.action) && event.label.name === 'merge-ready') {
  const pr = event.pull_request;
  if (event.action === 'unlabeled') {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ repo, number: pr.number, mode: 'automerge-off' }));
    process.exit(0);
  }
  const sender = event.sender.login;
  if (!isBot(sender) && !(await isTrusted(sender))) skip(`${sender} is not a collaborator`);
  if (pr.draft || pr.labels.some(l => /do.?not.?land/i.test(l.name))) skip('PR is not ready to land');
  const approver = await headApprover(pr);
  if (!approver) skip('merge-ready, but no collaborator has approved the latest commit, or changes are requested');
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({ repo, number: pr.number, mode: 'automerge', approver, approvedSha: pr.head.sha })
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
if (event.action === 'unlabeled') skip('label removed');
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
  // The bot can be addressed anywhere in a comment, taking the rest of it as
  // the command, but not from code or quotes, so quoting a command in a reply
  // doesn't run it again.
  const prose = body
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n');
  const m = /(?:^|[^\w@/-])@(?:wasm-bindgen-bot|wbg-bot)(?![\w\-[])[\s,:]+(\S[\s\S]*)$/.exec(prose);
  if (!m) skip('comment is not to the bot');
  m[1] = m[1].trim();
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
// requested or a review of its own PR, `bot-review` to PRs whose rebase took
// decisions, and `bot-rebase` to auto-merge and its own
// PRs that a merge left conflicting.
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
  // Once the PR below the bottom layer has merged, the bottom layer is
  // unstacked: moved onto the default branch if it isn't already, dropping
  // the merged PR's commits, which a squash merge leaves on the branch.
  const merged = (await paginate(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, 100)).filter(
    p => p.merged_at && p.number !== pr.number && p.head.sha !== pr.head.sha
  );
  let baseRef = pr.base.ref;
  let upstream = null;
  let retarget = null;
  const lower = merged.find(p => p.head.ref === pr.base.ref && p.head.repo?.full_name === repo);
  if (lower) {
    baseRef = retarget = (await gh(`/repos/${repo}`)).default_branch;
    upstream = lower;
  } else {
    const { commits = [] } = await gh(`/repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}?per_page=250`);
    const order = new Map(commits.map((c, i) => [c.sha, i]));
    upstream = merged.filter(p => order.has(p.head.sha)).sort((a, b) => order.get(b.head.sha) - order.get(a.head.sha))[0];
  }
  const stack = [];
  const queue = [{ pr, parent: null }];
  let text = `Base branch: ${baseRef}\n\nLayers, bottom up:\n`;
  while (queue.length) {
    const { pr: p, parent } = queue.shift();
    const from = !parent && upstream ? upstream.head.sha : null;
    stack.push({ number: p.number, headRef: p.head.ref, headSha: p.head.sha, parent, ...(from && { upstream: from }) });
    text +=
      `\n## #${p.number}: ${p.title}\n\nBranch: ${p.head.ref} @ ${p.head.sha}\n` +
      `Rebase onto: ${parent ? `the rebased ${parent}` : baseRef}\n` +
      (from ? `Rebase from: ${from}, the head of #${upstream.number}, which merged; drop its commits\n` : '') +
      `\n${p.body || '(no description)'}\n`;
    for (const child of open.filter(c => c.base.ref === p.head.ref)) queue.push({ pr: child, parent: p.head.ref });
  }
  let pinText = '';
  for (const l of stack) {
    const pins = await stalePins(l.number, l.headSha, baseRef);
    if (pins.length) l.pins = pins.length;
    for (const p of pins) pinText += `- #${l.number}, \`${p.file}\`: ${p.repo} ${p.sha} -> ${p.to} (${p.via})\n`;
  }
  if (pinText) writeFileSync(join(ctx, 'pins.md'), pinText);
  Object.assign(meta, { baseRef, stack, ...(retarget && { retarget }) });
  writeFileSync(join(ctx, 'stack.md'), text);
  await writeGuide(baseRef);
  setOutput('checkout-ref', baseRef);
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
  // The bot's rebases only move the PR onto newer code; its other pushes are
  // reviewed like anyone's. Rebases that took decisions ask for a review.
  if (event.action === 'synchronize' && isBot(event.sender?.login)) {
    const res = await gh(`/repos/${repo}/compare/${event.before}...${event.after}`, { raw: true });
    if (!res.ok || (await res.json()).status !== 'ahead') skip('rebase by the bot');
  }
  // Third parties' pushes are only re-reviewed on request, but a push that
  // cancelled the opening review still gets the first one. Pushes by the bot
  // or a collaborator are always reviewed, whoever opened the PR.
  const pusher = event.sender?.login;
  if (event.action === 'synchronize' && !isBot(pusher) && !(await isTrusted(pusher))) {
    const reviewed = (await paginate(`/repos/${repo}/pulls/${number}/reviews`)).some(r => isBot(r.user?.login));
    const labelled = pr.labels.some(l => l.name === 'merge-ready');
    if (reviewed || labelled) skip(`pushes by ${pusher} are only re-reviewed on request`);
  }
  meta.headSha = pr.head.sha;
  // Anyone can comment on the bot's own PRs, but only collaborators' and the
  // bot's words reach the runs that work on them or push to a PR.
  const botPr = isBot(pr.user.login);
  const heard = async login => !(botPr || mode === 'pr') || isBot(login) || (await isTrusted(login));
  if (meta.threadComment) {
    const thread = (await reviewThreads(number)).find(t =>
      t.comments.nodes.some(c => c.databaseId === meta.threadComment)
    );
    if (!thread) skip('could not find the review thread');
    meta.threadId = thread.id;
    request += `\n\n(Asked in the review thread on ${thread.path}:${thread.line ?? thread.originalLine}, id ${thread.id}.)`;
  }
  if (mode === 'pr') {
    // Forks take pushes from the app when their author allows edits by
    // maintainers.
    if (!pr.head.repo) skip('the PR\'s fork is gone');
    if (pr.head.repo.full_name !== repo && !pr.maintainer_can_modify) {
      skip('the PR\'s author doesn\'t allow edits by maintainers');
    }
    meta.prompt = 'pr-update';
    meta.headRef = pr.head.ref;
    meta.headRepo = pr.head.repo.full_name;
    meta.botPr = botPr;
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
      `Base: ${pr.base.ref}\nHead: ${pr.head.label} @ ${pr.head.sha}\n` +
      `Opened: ${pr.created_at}\nLast commit: ${(await gh(`/repos/${repo}/commits/${pr.head.sha}`)).commit.committer.date}\n` +
      `Mergeable: ${pr.mergeable ?? 'unknown'}\n\n` +
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
        const { status, files: changed = [] } = await res.json();
        const text = status === 'diverged' ? await rebasedChanges(pr, previous.commit_id) : toDiff(changed);
        if (text) writeFileSync(join(ctx, 'changes-since-review.patch'), text);
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
  if (mode === 'triage') {
    // Triage asks whether the default branch already has what the PR does.
    meta.prompt = 'triage-pr';
    const merged = (await paginate(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, 500))
      .filter(p => p.merged_at);
    writeFileSync(join(ctx, 'merged-prs.txt'), merged.map(p => `#${p.number} ${p.merged_at.slice(0, 10)} ${p.title}`).join('\n') + '\n');
    setOutput('checkout-ref', pr.base.repo.default_branch);
  } else {
    setOutput('checkout-ref', pr.head.sha);
  }
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

if (!isPr || followOn || mode === 'triage') {
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
