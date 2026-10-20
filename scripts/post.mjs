// Turns the model's untrusted structured output into GitHub writes, enforcing
// what it may touch: one comment or approval review anchored to diff lines,
// or existing labels plus a comment.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gh, graphql, paginate, repo, commentableLines, summary, isBot, reviewThreads, isTrusted } from './lib.mjs';

const MAX_COMMENTS = 25;
const MAX_ROUNDS = 3;
const MAX_BODY = 60_000;

const result = JSON.parse(readFileSync(process.env.BOT_RESULT, 'utf8'));
if (result.skip) {
  console.log(`Skipped: ${result.skip}`);
  process.exit(0);
}
if (result.repo !== repo) throw new Error(`result is for ${result.repo}`);
const { number, output } = result;

// Mentions in model output would ping arbitrary users. Code spans and blocks
// don't ping, so they are left intact.
const clean = (s, max = MAX_BODY) =>
  String(s)
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|\W)@(?=[A-Za-z0-9])/g, '$1@\u200b')))
    .join('')
    .slice(0, max);

async function unlabel(label) {
  const res = await gh(`/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
    raw: true,
  });
  if (!res.ok && res.status !== 404) console.log(`Removing ${label}: ${res.status} ${await res.text()}`);
}

if (result.mode === 'review') {
  const files = await paginate(`/repos/${repo}/pulls/${number}/files`, 3000);
  const lines = new Map(files.map(f => [f.filename, commentableLines(f.patch)]));

  // A line number that doesn't land on the diff is re-anchored to the nearest
  // line with the quoted text, then falls back to a file-level comment.
  const inline = [];
  const fileLevel = [];
  const extra = [];
  for (const c of output.comments.slice(0, MAX_COMMENTS)) {
    const body = clean(c.body, 8000);
    const valid = lines.get(c.path);
    if (!valid) {
      extra.push(`**\`${c.path}\`**: ${body}`);
      continue;
    }
    let line = c.line;
    if (valid.get(line)?.trim() !== c.code.trim()) {
      const matches = [...valid].filter(([, text]) => text.trim() === c.code.trim());
      matches.sort(([a], [b]) => Math.abs(a - c.line) - Math.abs(b - c.line));
      line = matches[0]?.[0] ?? (valid.has(line) ? line : null);
    }
    if (line == null) {
      fileLevel.push({ path: c.path, body });
      continue;
    }
    const start = c.start_line != null ? c.start_line + (line - c.line) : null;
    inline.push({
      path: c.path,
      line,
      side: 'RIGHT',
      ...(start != null && start < line && valid.has(start) && { start_line: start, start_side: 'RIGHT' }),
      body,
    });
  }

  // A newer push supersedes this run; its own run posts instead. This is
  // checked last so a cancelled run that got this far doesn't post stale.
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' || pr.head.sha !== result.headSha) {
    console.log(`Not posting: PR is ${pr.state} at ${pr.head.sha}, analyzed ${result.headSha}`);
    process.exit(0);
  }

  // By default only collaborators' PRs may be approved, since PR content can
  // steer the model.
  let event = 'COMMENT';
  const blockers = output.approve ? [] : [...output.approval_blockers];
  if (output.approve) {
    const policy = process.env.BOT_APPROVE;
    const allowed =
      policy === 'all' || (policy === 'collaborators' && (await isTrusted(pr.user.login)));
    if (!allowed) {
      blockers.push(
        policy === 'never'
          ? 'Approvals are disabled for this repository.'
          : 'Approval is limited to PRs from collaborators; this review found no blocking concerns.'
      );
    } else {
      event = 'APPROVE';
    }
  }
  // GitHub doesn't let the app approve its own PRs. Instead it sends them back
  // to the PR run with `bot-pr` while it has concerns, up to a limit, after
  // which they are left for a human.
  const ownPr = isBot(pr.user.login);
  let iterate = false;
  if (ownPr) {
    event = 'COMMENT';
    if (output.approve) {
      blockers.length = 0;
    } else if (pr.commits - 1 < MAX_ROUNDS) {
      iterate = true;
    } else {
      blockers.push(`Leaving this for a human reviewer after ${MAX_ROUNDS} automated rounds.`);
    }
  }
  if (event !== 'APPROVE' && !(ownPr && output.approve) && !blockers.length) blockers.push('No reason given.');

  // An empty summary means nothing to add: approve bare, or post nothing.
  const silent = !ownPr && !output.summary.trim() && !inline.length && !fileLevel.length && !extra.length;

  // A silent approval the policy downgraded still says why it isn't approved.
  const skip = silent && !output.approve;
  const body = silent && event === 'APPROVE' ? '' : clean(
    output.summary +
      (ownPr && output.approve
        ? `${output.summary.trim() ? '\n\n' : ''}No further concerns; ready for a human review.`
        : event === 'APPROVE' || !blockers.length
          ? ''
          : `${output.summary.trim() ? '\n\n' : ''}**Requesting changes:**\n${blockers.map(b => `- ${b}`).join('\n')}`) +
      (extra.length ? `\n\n${extra.join('\n\n')}` : '')
  );

  const review = { commit_id: result.headSha, event, body, comments: inline };
  const res =
    skip
      ? { ok: true, status: 204 }
      : await gh(`/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', body: review, raw: true });
  if (res.status === 422 && inline.length) {
    console.log(`Inline comments rejected (${await res.text()}), posting them per file`);
    await gh(`/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { ...review, comments: [] },
    });
    fileLevel.push(...inline.map(c => ({ path: c.path, body: `Line ${c.line}: ${c.body}` })));
  } else if (!res.ok) {
    throw new Error(`posting review: ${res.status} ${await res.text()}`);
  }

  for (const c of fileLevel) {
    await gh(`/repos/${repo}/pulls/${number}/comments`, {
      method: 'POST',
      body: { ...c, commit_id: result.headSha, subject_type: 'file' },
    });
  }

  if (result.label) await unlabel(result.label);

  // Only the bot's own open threads may be resolved.
  const threads = new Map((await reviewThreads(number)).map(t => [t.id, t]));
  let resolved = 0;
  // Finish threads a previous run replied to but failed to resolve.
  for (const t of threads.values()) {
    const last = t.comments.nodes.at(-1);
    if (
      !t.isResolved &&
      isBot(t.comments.nodes[0]?.author?.login) &&
      isBot(last?.author?.login) &&
      last.body.startsWith('Addressed in ')
    ) {
      await graphql(
        `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
        { id: t.id }
      );
      t.isResolved = true;
      resolved++;
    }
  }
  for (const { thread_id, reason } of output.resolve.slice(0, MAX_COMMENTS)) {
    const t = threads.get(thread_id);
    if (!t || t.isResolved || !isBot(t.comments.nodes[0]?.author?.login)) {
      console.log(`Not resolving ${thread_id}: not an open bot thread`);
      continue;
    }
    await graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          clientMutationId
        }
        resolveReviewThread(input: { threadId: $id }) { clientMutationId }
      }`,
      { id: thread_id, body: clean(`Addressed in ${result.headSha.slice(0, 7)}: ${reason}`, 4000) }
    );
    resolved++;
  }
  if (iterate) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: ['bot-pr'] } });
  }
  // On its own PRs, `merge-ready` stands in for the approval the bot can't give.
  if (ownPr && output.approve) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: ['merge-ready'] } });
  } else if (ownPr) {
    await unlabel('merge-ready');
  }

  // Only questions where a collaborator has the last word get an answer.
  let replied = 0;
  for (const { thread_id, body } of (output.replies ?? []).slice(0, MAX_COMMENTS)) {
    const t = threads.get(thread_id);
    const last = t?.comments.nodes.at(-1)?.author?.login;
    if (!t || t.isResolved || isBot(last) || !(await isTrusted(last))) {
      console.log(`Not replying to ${thread_id}: not an open collaborator question`);
      continue;
    }
    await graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          clientMutationId
        }
      }`,
      { id: thread_id, body: clean(body, 8000) }
    );
    replied++;
  }
  summary(`${skip ? 'Skipped' : 'Posted'} ${event} review on #${number} with ${inline.length} inline comments, resolved ${resolved} threads, answered ${replied}`);
} else if (result.mode === 'pr') {
  await postPr();
} else if (result.mode === 'rebase') {
  await rebase();
} else if (result.mode === 'automerge') {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' || pr.draft || pr.auto_merge) {
    console.log(`Not enabling auto-merge: PR is ${pr.draft ? 'a draft' : pr.state}${pr.auto_merge ? ', already enabled' : ''}`);
  } else {
    await graphql(
      `mutation($id: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId }
      }`,
      { id: pr.node_id }
    );
    summary(`Enabled auto-merge on #${number} after ${result.approver}'s approval`);
  }
} else if (result.mode === 'ask') {
  const answer = String(output.answer).trim();
  if (answer && result.threadId) {
    await graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          clientMutationId
        }
      }`,
      { id: result.threadId, body: clean(answer) }
    );
  } else if (answer) {
    await gh(`/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: clean(`Answering ${result.requester} in ${result.commentUrl}:\n\n${answer}`) },
    });
  }
  summary(`Answered a question on #${number}`);
} else {
  // Labels the bot controls itself are only set from their dedicated fields.
  const controlled = l => l === 'ready-for-pr' || l === 'merge-ready' || l.startsWith('bot-');
  const dup = Number.isInteger(output.duplicate_of) && output.duplicate_of !== number ? output.duplicate_of : null;
  const close = output.close === 'duplicate' && !dup ? null : output.close;
  // Only triage marks issues ready; an investigation starts the PR itself.
  const triage = result.mode === 'triage';
  const ready = triage && output.ready_for_pr && !close;
  const createPr = result.mode === 'investigate' && output.create_pr && !close;
  const existing = new Set((await paginate(`/repos/${repo}/labels`)).map(l => l.name));
  const labels = output.labels.filter(l => existing.has(l) && !controlled(l)).slice(0, 6);
  const dropped = output.labels.filter(l => !labels.includes(l));
  if (dropped.length) console.log(`Dropped labels: ${dropped.join(', ')}`);
  if (ready) labels.push('ready-for-pr');
  if (labels.length) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels } });
  }
  if (triage && !ready) await unlabel('ready-for-pr');
  if (result.label) await unlabel(result.label);

  let comment = output.comment?.trim() || '';
  if (dup && !comment.includes(`#${dup}`)) {
    comment = `This looks like a duplicate of #${dup}.${comment ? `\n\n${comment}` : ''}`;
  }
  if (comment) {
    const marker = createPr && result.cutoff ? `\n\n<!-- wbg-bot cutoff: ${result.cutoff} -->` : '';
    await gh(`/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: clean(comment) + marker },
    });
  }
  // Closing is only explained by the comment, so never close silently.
  let closed = false;
  if (close && comment) {
    const issue = await gh(`/repos/${repo}/issues/${number}`);
    if (issue.state === 'open') {
      const reason = { resolved: 'completed', duplicate: 'duplicate', off_topic: 'not_planned' }[close];
      const patch = state_reason =>
        gh(`/repos/${repo}/issues/${number}`, { method: 'PATCH', raw: true, body: { state: 'closed', state_reason } });
      let res = await patch(reason);
      if (res.status === 422) res = await patch('not_planned');
      if (!res.ok) throw new Error(`closing #${number}: ${res.status} ${await res.text()}`);
      closed = true;
    }
  }
  // Added after the comment, which the PR run reads as its brief. The label
  // event comes from the app, which the PR run accepts as a requester.
  if (createPr && comment) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: ['bot-pr'] } });
  }
  summary(`${triage ? `Triaged #${number}: ready-for-pr ${ready}` : `Investigated #${number} (${output.reproduced}): PR ${createPr && !!comment}`}, labels [${labels.join(', ')}], comment ${comment ? 'posted' : 'none'}${closed ? `, closed as ${close}` : ''}`);
}

// Commits the files the model changed onto the commit they were based on.
async function commitFiles(message) {
  const base = await gh(`/repos/${repo}/git/commits/${result.baseSha}`);
  const tree = [];
  for (const f of result.files) {
    if (f.deleted) {
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await gh(`/repos/${repo}/git/blobs`, {
      method: 'POST',
      body: { content: f.content, encoding: 'base64' },
    });
    tree.push({ path: f.path, mode: f.mode, type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(`/repos/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: base.tree.sha, tree },
  });
  return gh(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [result.baseSha] },
  });
}

function comment(body) {
  return gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: clean(body) } });
}

// Opens a PR for an issue, or adds a commit to one of the bot's own PRs. Bot
// PRs are then reviewed by the bot, which can send them back with `bot-pr`.
async function postPr() {
  if (result.label) await unlabel(result.label);
  if (result.headRef) return updatePr();

  // Without an issue, the PR comes from a request made in the Actions tab.
  const forIssue = number !== null;
  if (forIssue && (await gh(`/repos/${repo}/issues/${number}`)).state !== 'open') {
    console.log('Issue was closed, not opening a PR');
    return;
  }
  const note = output.comment?.trim();
  if (!result.files?.length) {
    if (note && forIssue) await comment(note);
    summary(`No changes${forIssue ? ` for #${number}` : ''}${note ? `: ${note}` : ''}`);
    return;
  }

  const title = String(output.title).trim().slice(0, 200);
  const commit = await commitFiles(forIssue ? `${title}\n\nCloses #${number}` : title);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  let branch = forIssue ? `wbg-bot/issue-${number}` : `wbg-bot/${slug || 'change'}`;
  let ref = await gh(`/repos/${repo}/git/refs`, {
    method: 'POST',
    raw: true,
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  if (ref.status === 422) {
    branch += `-${commit.sha.slice(0, 7)}`;
    ref = await gh(`/repos/${repo}/git/refs`, {
      method: 'POST',
      raw: true,
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    });
  }
  if (!ref.ok) throw new Error(`creating ${branch}: ${ref.status} ${await ref.text()}`);

  let body = String(output.body).trim();
  if (forIssue && !new RegExp(`#${number}\\b`).test(body)) body += `\n\nCloses #${number}`;
  body += isBot(result.requester)
    ? `\n\n_Started from the investigation in #${number}._`
    : `\n\n_Requested by ${result.requester}${forIssue ? '' : ' from the Actions tab'}._`;
  const pr = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: { title, head: branch, base: result.baseRef, body: clean(body) },
  });
  await gh(`/repos/${repo}/issues/${pr.number}/labels`, { method: 'POST', body: { labels: ['bot-review'] } });
  summary(`Opened ${pr.html_url}${forIssue ? ` for #${number}` : ''} with ${result.files.length} files`);
}

async function updatePr() {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' || pr.head.sha !== result.baseSha) {
    console.log(`Not pushing: PR is ${pr.state} at ${pr.head.sha}, worked on ${result.baseSha}`);
    return;
  }
  let sha = null;
  if (result.files?.length) {
    const commit = await commitFiles(String(output.commit_message).trim() || 'Address review feedback');
    // Never a force push: if the branch moved meanwhile, this fails.
    await gh(`/repos/${repo}/git/refs/heads/${result.headRef}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    });
    sha = commit.sha;
  }

  // Threads the bot started are resolved once addressed by a commit; other
  // reviewers' threads only get a reply, for them to resolve.
  const threads = new Map((await reviewThreads(number)).map(t => [t.id, t]));
  let replied = 0;
  for (const { thread_id, reply } of (output.addressed ?? []).slice(0, MAX_COMMENTS)) {
    const t = threads.get(thread_id);
    if (!t || t.isResolved) continue;
    const resolve = sha && isBot(t.comments.nodes[0]?.author?.login);
    await graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          clientMutationId
        }
      }`,
      { id: thread_id, body: clean(sha ? `In ${sha.slice(0, 7)}: ${reply}` : reply, 8000) }
    );
    if (resolve) {
      await graphql(
        `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }`,
        { id: thread_id }
      );
    }
    replied++;
  }
  const note = output.comment?.trim();
  if (note) await comment(note);
  if (sha) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels: ['bot-review'] } });
  }
  summary(`Updated #${number}: ${sha ? `pushed ${sha.slice(0, 7)} with ${result.files.length} files` : 'no changes'}, replied to ${replied} threads`);
}

// Rebases a PR, or its whole stack, onto the base with git, never resolving
// conflicts, and force-pushes every layer atomically, only if none has moved
// since the request.
async function rebase() {
  const { stack } = result;
  const botUser = await gh(`/users/${encodeURIComponent('wasm-bindgen-bot[bot]')}`);
  const dir = mkdtempSync(join(tmpdir(), 'bot-rebase-'));
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  const git = (...args) =>
    spawnSync(
      'git',
      [
        '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
        '-c', `user.name=${botUser.login}`,
        '-c', `user.email=${botUser.id}+${botUser.login}@users.noreply.github.com`,
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' }
    );
  const must = (...args) => {
    const r = git(...args);
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.replaceAll(auth, '***')}`);
    return r.stdout.trim();
  };
  const unlabelAll = async () => {
    for (const layer of stack) {
      const res = await gh(`/repos/${repo}/issues/${layer.number}/labels/bot-rebase`, { method: 'DELETE', raw: true });
      if (!res.ok && res.status !== 404) console.log(`Removing bot-rebase from #${layer.number}: ${res.status}`);
    }
  };

  must('init', '-q');
  must('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  must('fetch', '-q', '--filter=blob:none', 'origin',
    `+refs/heads/${result.baseRef}:refs/remotes/origin/${result.baseRef}`,
    ...stack.map(l => `+refs/heads/${l.headRef}:refs/remotes/origin/${l.headRef}`));
  for (const l of stack) {
    const now = must('rev-parse', `origin/${l.headRef}`);
    if (now !== l.headSha) {
      console.log(`Not rebasing: ${l.headRef} moved to ${now} since the request`);
      await unlabelAll();
      return;
    }
  }

  const oldHead = new Map(stack.map(l => [l.headRef, l.headSha]));
  const newHead = new Map();
  for (const l of stack) {
    must('checkout', '-q', '-B', 'work', l.headSha);
    const r = l.parent
      ? git('rebase', '-q', '--onto', newHead.get(l.parent), oldHead.get(l.parent))
      : git('rebase', '-q', `origin/${result.baseRef}`);
    if (r.status !== 0) {
      const conflicts = git('diff', '--name-only', '--diff-filter=U').stdout.trim().split('\n').filter(Boolean);
      git('rebase', '--abort');
      await comment(
        `Rebasing ${stack.length > 1 ? `the stack (at #${l.number}) ` : ''}onto \`${result.baseRef}\` conflicts` +
          (conflicts.length ? ` in:\n\n${conflicts.map(f => `- \`${f}\``).join('\n')}` : '.') +
          '\n\nThis needs a manual rebase.'
      );
      await unlabelAll();
      summary(`Rebase of #${number} conflicts at #${l.number}`);
      return;
    }
    newHead.set(l.headRef, must('rev-parse', 'HEAD'));
  }

  const changed = stack.filter(l => newHead.get(l.headRef) !== l.headSha);
  if (!changed.length) {
    await unlabelAll();
    summary(`#${number} is already up to date with ${result.baseRef}`);
    return;
  }
  const push = git('push', '-q', '--atomic',
    ...changed.map(l => `--force-with-lease=refs/heads/${l.headRef}:${l.headSha}`),
    'origin', ...changed.map(l => `${newHead.get(l.headRef)}:refs/heads/${l.headRef}`));
  await unlabelAll();
  if (push.status !== 0) {
    const err = push.stderr.replaceAll(auth, '***');
    // The app can't push commits that change workflows; otherwise a branch
    // moved since the request, and whoever moved it wins.
    if (/workflow/i.test(err)) {
      await comment('Rebased cleanly, but I can\'t push commits that change workflows, so this needs a manual rebase.');
    }
    throw new Error(`push failed: ${err}`);
  }
  summary(`Rebased ${changed.map(l => `#${l.number}`).join(', ')} onto ${result.baseRef}`);
}
