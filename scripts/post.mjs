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
      (event === 'APPROVE' ? '' : `${output.summary.trim() ? '\n\n' : ''}**Not approving:**\n${blockers.map(b => `- ${b}`).join('\n')}`) +
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

  const unlabel = await gh(`/repos/${repo}/issues/${number}/labels/bot-request-review`, {
    method: 'DELETE',
    raw: true,
  });
  if (!unlabel.ok && unlabel.status !== 404) {
    console.log(`Removing bot-request-review label: ${unlabel.status} ${await unlabel.text()}`);
  }

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
} else {
  const existing = new Set((await paginate(`/repos/${repo}/labels`)).map(l => l.name));
  const labels = output.labels.filter(l => existing.has(l)).slice(0, 6);
  const dropped = output.labels.filter(l => !existing.has(l));
  if (dropped.length) console.log(`Dropped unknown labels: ${dropped.join(', ')}`);
  if (labels.length) {
    await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels } });
  }

  let comment = output.comment?.trim() || '';
  const dup = output.duplicate_of;
  if (Number.isInteger(dup) && dup !== number && !comment.includes(`#${dup}`)) {
    comment = `This looks like a duplicate of #${dup}.${comment ? `\n\n${comment}` : ''}`;
  }
  if (comment) {
    await gh(`/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: clean(comment) },
    });
  }
  summary(`Triaged #${number}: labels [${labels.join(', ')}], comment ${comment ? 'posted' : 'none'}`);
}
