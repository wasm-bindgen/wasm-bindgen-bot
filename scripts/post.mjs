// Turns the model's untrusted structured output into GitHub writes, enforcing
// what it may touch: one comment or approval review anchored to diff lines,
// or existing labels plus a comment.
import { readFileSync } from 'node:fs';
import { gh, paginate, repo, commentableLines, summary } from './lib.mjs';

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

// Mentions in model output would ping arbitrary users.
const clean = (s, max = MAX_BODY) =>
  String(s).replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​').slice(0, max);

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
  const body = clean(
    output.summary + (extra.length ? `\n\n${extra.join('\n\n')}` : '')
  );

  // An approval only covers the commit that was analyzed, and by default only
  // maintainers' PRs, since PR content can steer the model.
  let event = 'COMMENT';
  if (output.approve) {
    const pr = await gh(`/repos/${repo}/pulls/${number}`);
    const policy = process.env.BOT_APPROVE;
    const allowed =
      policy === 'all' || (policy === 'maintainers' && MAINTAINERS.includes(pr.author_association));
    if (!allowed) console.log(`Not approving: ${pr.user.login} is ${pr.author_association}, policy ${policy}`);
    else if (pr.head.sha !== result.headSha) console.log('Not approving: head moved since analysis');
    else event = 'APPROVE';
  }

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
  summary(`Posted ${event} review on #${number} with ${inline.length} inline comments`);
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
