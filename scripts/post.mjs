// Turns the model's untrusted structured output into GitHub writes, enforcing
// what it may touch: one comment or approval review anchored to diff lines,
// or existing labels plus a comment.
import { readFileSync } from 'node:fs';
import { gh, graphql, paginate, repo, commentableLines, summary, isBot, reviewThreads, isTrusted } from './lib.mjs';

const MAX_COMMENTS = 25;
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
  if (event !== 'APPROVE' && !blockers.length) blockers.push('No reason given.');

  // An empty summary means nothing to add: approve bare, or post nothing.
  const silent = !output.summary.trim() && !inline.length && !fileLevel.length && !extra.length;

  // A silent approval the policy downgraded still says why it isn't approved.
  const skip = silent && !output.approve;
  const body = silent && event === 'APPROVE' ? '' : clean(
    output.summary +
      (event === 'APPROVE' ? '' : `${output.summary.trim() ? '\n\n' : ''}**Requesting changes:**\n${blockers.map(b => `- ${b}`).join('\n')}`) +
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
  summary(`${skip ? 'Skipped' : 'Posted'} ${event} review on #${number} with ${inline.length} inline comments, resolved ${resolved} threads`);
} else if (result.mode === 'pr') {
  await postPr();
} else {
  // Labels the bot controls itself are only set from their dedicated fields.
  const controlled = l => l === 'ready-for-pr' || l.startsWith('bot-');
  const dup = Number.isInteger(output.duplicate_of) && output.duplicate_of !== number ? output.duplicate_of : null;
  const close = output.close === 'duplicate' && !dup ? null : output.close;
  if (close) output.ready_for_pr = false;
  const existing = new Set((await paginate(`/repos/${repo}/labels`)).map(l => l.name));
  const labels = output.labels.filter(l => existing.has(l) && !controlled(l)).slice(0, 6);
  const dropped = output.labels.filter(l => !labels.includes(l));
  if (dropped.length) console.log(`Dropped labels: ${dropped.join(', ')}`);
  if (output.ready_for_pr) labels.push('ready-for-pr');
  if (labels.length) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels } });
  }
  if (!output.ready_for_pr) await unlabel('ready-for-pr');
  if (result.label) await unlabel(result.label);

  let comment = output.comment?.trim() || '';
  if (dup && !comment.includes(`#${dup}`)) {
    comment = `This looks like a duplicate of #${dup}.${comment ? `\n\n${comment}` : ''}`;
  }
  if (comment) {
    await gh(`/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: clean(comment) },
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
  summary(`${result.mode === 'investigate' ? `Investigated (${output.reproduced})` : 'Triaged'} #${number}: labels [${labels.join(', ')}], ready-for-pr ${output.ready_for_pr}, comment ${comment ? 'posted' : 'none'}${closed ? `, closed as ${close}` : ''}`);
}

// Commits the files the model changed onto the base commit through the Git
// Data API, pushes them to a new branch and opens a PR for the issue.
async function postPr() {
  if (result.label) await unlabel(result.label);
  const issue = await gh(`/repos/${repo}/issues/${number}`);
  if (issue.state !== 'open') {
    console.log('Issue was closed, not opening a PR');
    return;
  }
  const comment = output.comment?.trim();
  if (!result.files?.length) {
    if (comment) {
      await gh(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body: clean(comment) } });
    }
    summary(`No changes for #${number}${comment ? ', commented' : ''}`);
    return;
  }

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
  const title = String(output.title).trim().slice(0, 200);
  const commit = await gh(`/repos/${repo}/git/commits`, {
    method: 'POST',
    body: { message: `${title}\n\nCloses #${number}`, tree: newTree.sha, parents: [result.baseSha] },
  });

  let branch = `wbg-bot/issue-${number}`;
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
  if (!new RegExp(`#${number}\\b`).test(body)) body += `\n\nCloses #${number}`;
  body += `\n\n_Requested by ${result.requester}._`;
  const pr = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: { title, head: branch, base: result.baseRef, body: clean(body) },
  });
  summary(`Opened ${pr.html_url} for #${number} with ${result.files.length} files`);
}
