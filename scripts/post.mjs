// Turns the model's untrusted structured output into GitHub writes, enforcing
// what it may touch: one comment or approval review anchored to diff lines,
// or existing labels plus a comment.
import { readFileSync } from 'node:fs';
import { gh, graphql, paginate, repo, commentableLines, summary, isBot, reviewThreads } from './lib.mjs';

const MAINTAINERS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
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

  const inline = [];
  const extra = [];
  for (const c of output.comments.slice(0, MAX_COMMENTS)) {
    const valid = lines.get(c.path);
    const ok =
      valid?.has(c.line) &&
      (c.start_line == null || (c.start_line < c.line && valid.has(c.start_line)));
    const body = clean(c.body, 8000);
    if (!ok) {
      extra.push(`**\`${c.path}:${c.line}\`**: ${body}`);
      continue;
    }
    inline.push({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      ...(c.start_line != null && { start_line: c.start_line, start_side: 'RIGHT' }),
      body,
    });
  }
  // An approval only covers the commit that was analyzed, and by default only
  // maintainers' PRs, since PR content can steer the model.
  let event = 'COMMENT';
  const blockers = output.approve ? [] : [...output.approval_blockers];
  if (output.approve) {
    const pr = await gh(`/repos/${repo}/pulls/${number}`);
    const policy = process.env.BOT_APPROVE;
    const allowed =
      policy === 'all' || (policy === 'maintainers' && MAINTAINERS.includes(pr.author_association));
    if (!allowed) {
      blockers.push(
        policy === 'never'
          ? 'Approvals are disabled for this repository.'
          : 'Approval is limited to PRs from maintainers; this review found no blocking concerns.'
      );
    } else if (pr.head.sha !== result.headSha) {
      blockers.push('New commits were pushed during this review.');
    } else {
      event = 'APPROVE';
    }
  }
  if (event !== 'APPROVE' && !blockers.length) blockers.push('No reason given.');

  const body = clean(
    output.summary +
      (event === 'APPROVE' ? '' : `\n\n**Not approving:**\n${blockers.map(b => `- ${b}`).join('\n')}`) +
      (extra.length ? `\n\n${extra.join('\n\n')}` : '')
  );

  const review = { commit_id: result.headSha, event, body, comments: inline };
  const res = await gh(`/repos/${repo}/pulls/${number}/reviews`, {
    method: 'POST',
    body: review,
    raw: true,
  });
  if (res.status === 422 && inline.length) {
    console.log(`Inline comments rejected (${await res.text()}), folding into body`);
    const folded = inline.map(c => `**\`${c.path}:${c.line}\`**: ${c.body}`);
    await gh(`/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { ...review, body: clean(`${body}\n\n${folded.join('\n\n')}`), comments: [] },
    });
  } else if (!res.ok) {
    throw new Error(`posting review: ${res.status} ${await res.text()}`);
  }

  // Only the bot's own open threads may be resolved.
  const threads = new Map((await reviewThreads(number)).map(t => [t.id, t]));
  let resolved = 0;
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
  summary(`Posted ${event} review on #${number} with ${inline.length} inline comments, resolved ${resolved} threads`);
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
