// Turns the model's untrusted structured output into GitHub writes, enforcing
// what it may touch: one comment or approval review anchored to diff lines,
// or existing labels plus a comment.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
} else if (result.mode === 'flag-conflicts') {
  for (const n of result.numbers) {
    await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: { labels: ['bot-rebase'] } });
  }
  summary(`Requested rebases of ${result.numbers.map(n => `#${n}`).join(', ')}`);
} else if (result.mode === 'automerge') {
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (pr.state !== 'open' || pr.draft || pr.auto_merge) {
    console.log(`Not enabling auto-merge: PR is ${pr.draft ? 'a draft' : pr.state}${pr.auto_merge ? ', already enabled' : ''}`);
  } else if (!(await unstackIfLast(number))) {
    summary(`Not enabling auto-merge on #${number}: GitHub can't auto-merge it while its stack has other open PRs`);
  } else {
    await graphql(
      `mutation($id: ID!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId }
      }`,
      { id: pr.node_id }
    );
    summary(`Enabled auto-merge on #${number} after ${result.approver}'s approval`);
  }
} else if (result.mode === 'triage' && result.headSha) {
  const controlled = l => l === 'ready-for-pr' || l === 'merge-ready' || l.startsWith('bot-');
  const existing = new Set((await paginate(`/repos/${repo}/labels`)).map(l => l.name));
  const labels = (output.labels ?? []).filter(l => existing.has(l) && !controlled(l)).slice(0, 6);
  if (labels.length) await gh(`/repos/${repo}/issues/${number}/labels`, { method: 'POST', body: { labels } });
  if (result.label) await unlabel(result.label);
  let note = output.comment?.trim() || '';
  const by = Number.isInteger(output.superseded_by) && output.superseded_by !== number ? output.superseded_by : null;
  const close = output.close === 'superseded' && !by ? null : output.close;
  if (by && close && !note.includes(`#${by}`)) note = `Superseded by #${by}.${note ? `\n\n${note}` : ''}`;
  // Closing is only explained by the comment, so never close silently.
  const pr = await gh(`/repos/${repo}/pulls/${number}`);
  if (note) await comment(note);
  let closed = false;
  if (close && note && pr.state === 'open') {
    await gh(`/repos/${repo}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
    closed = true;
  }
  summary(`Triaged PR #${number}: labels [${labels.join(', ')}], comment ${note ? 'posted' : 'none'}${closed ? `, closed as ${close}` : ''}`);
} else if (result.mode === 'issue') {
  const existing = Number.isInteger(output.existing) && output.existing !== number ? output.existing : null;
  let reply;
  if (existing) {
    reply = `#${existing} already covers this.`;
  } else {
    const have = new Set((await paginate(`/repos/${repo}/labels`)).map(l => l.name));
    const labels = (output.labels ?? []).filter(l => have.has(l) && l !== 'ready-for-pr' && l !== 'merge-ready' && !l.startsWith('bot-'));
    const issue = await gh(`/repos/${repo}/issues`, {
      method: 'POST',
      body: {
        title: String(output.title).trim().slice(0, 256),
        body: clean(`${String(output.body).trim()}\n\n_Follows on from #${number}, opened at ${result.requester}'s request._`),
        labels,
      },
    });
    reply = `Opened #${issue.number}.`;
  }
  if (result.threadId) {
    await graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
          clientMutationId
        }
      }`,
      { id: result.threadId, body: reply }
    );
  } else {
    await comment(result.commentUrl ? `${reply} (for ${result.commentUrl})` : reply);
  }
  summary(reply);
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

// Pushes a commit of the changed files to a fork's PR branch over git, which
// the app may do when the author allows edits by maintainers. The commit is
// built from the PR head fetched from this repository, and only pushed as a
// fast-forward.
async function pushToFork(message) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-fork-'));
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  const bot = await gh('/users/wasm-bindgen-bot%5Bbot%5D');
  const email = `${bot.id}+${bot.login}@users.noreply.github.com`;
  const git = (args, input) => {
    const r = spawnSync('git', ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, ...args], {
      cwd: dir,
      input,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: bot.login, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: bot.login, GIT_COMMITTER_EMAIL: email },
    });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.replaceAll(auth, '***')}`);
    return r.stdout.trim();
  };
  git(['init', '-q']);
  git(['fetch', '-q', '--filter=blob:none', `https://github.com/${repo}.git`, `refs/pull/${number}/head`]);
  if (git(['rev-parse', 'FETCH_HEAD']) !== result.baseSha) throw new Error('the PR moved while fetching it');
  git(['read-tree', result.baseSha]);
  for (const f of result.files) {
    if (f.path.startsWith('.github/')) continue;
    if (f.deleted) {
      git(['update-index', '--force-remove', '--', f.path]);
      continue;
    }
    const blob = git(['hash-object', '-w', '--stdin'], Buffer.from(f.content, 'base64'));
    git(['update-index', '--add', '--cacheinfo', `${f.mode},${blob},${f.path}`]);
  }
  const commit = git(['commit-tree', git(['write-tree']), '-p', result.baseSha, '-m', message]);
  git(['push', '-q', `https://github.com/${result.headRepo}.git`, `${commit}:refs/heads/${result.headRef}`]);
  return commit;
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
  // Issue references lead the description.
  if (forIssue && !new RegExp(`#${number}\\b`).test(body.split('\n\n')[0])) body = `Resolves #${number}.\n\n${body}`;
  body += isBot(result.requester)
    ? `\n\n_Started from the investigation in #${number}._`
    : `\n\n_Requested by ${result.requester}${forIssue ? '' : ' from the Actions tab'}._`;
  const pr = await gh(`/repos/${repo}/pulls`, {
    method: 'POST',
    body: { title, head: branch, base: result.baseRef, body: clean(body) },
  });
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
    const message = String(output.commit_message).trim() || 'Address review feedback';
    if (result.headRepo && result.headRepo !== repo) {
      sha = await pushToFork(message);
    } else {
      const commit = await commitFiles(message);
      // Never a force push: if the branch moved meanwhile, this fails.
      await gh(`/repos/${repo}/git/refs/heads/${result.headRef}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      });
      sha = commit.sha;
    }
    // An approval of someone else's PR predates the bot's commit.
    if (!result.botPr && pr.auto_merge) {
      await graphql(
        `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: pr.node_id }
      );
      await comment('I turned off auto-merge, since the approval predates my commit; re-approve to merge.');
    }
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
  summary(`Updated #${number}: ${sha ? `pushed ${sha.slice(0, 7)} with ${result.files.length} files` : 'no changes'}, replied to ${replied} threads`);
}

// GitHub can't auto-merge PRs in a stack. Once a PR is the last open one in
// its stack, the rest having merged or closed, the stack has done its job and
// is dissolved. Returns whether the PR is now in no stack.
async function unstackIfLast(n) {
  const res = await gh(`/repos/${repo}/stacks?pull_request=${n}`, { raw: true });
  if (!res.ok) return true;
  for (const st of await res.json()) {
    if (st.pull_requests.some(p => p.number !== n && p.state === 'open')) return false;
    const r = await gh(`/repos/${repo}/stacks/${st.number}/unstack`, { method: 'POST', raw: true });
    if (!r.ok) {
      console.log(`Unstacking #${n} from stack ${st.number}: ${r.status} ${await r.text()}`);
      return false;
    }
    console.log(`Unstacked #${n}, the last open PR of stack ${st.number}`);
  }
  return true;
}

// Pushes a stack the analyze job rebased, from its git bundle, after
// checking each rebased branch sits on the base or the rebased layer below,
// and only if no layer moved since the request. Layers where the model's
// resolution involved decisions lose auto-merge, since their approval
// predates those, and get a review.
async function rebase() {
  const { stack } = result;
  const dir = mkdtempSync(join(tmpdir(), 'bot-rebase-'));
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64');
  const git = (...args) =>
    spawnSync('git', ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
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
  const note = output.comment?.trim();

  if (!result.bundle) {
    if (note) await comment(note);
    await unlabelAll();
    summary(`Nothing rebased for #${number}`);
    return;
  }

  must('init', '-q');
  must('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  must('fetch', '-q', 'origin',
    `+refs/heads/${result.baseRef}:refs/remotes/origin/${result.baseRef}`,
    ...stack.map(l => `+refs/heads/${l.headRef}:refs/remotes/origin/${l.headRef}`));
  for (const l of stack) {
    const now = must('rev-parse', `origin/${l.headRef}`);
    if (now !== l.headSha) {
      console.log(`Not pushing: ${l.headRef} moved to ${now} since the request`);
      await unlabelAll();
      return;
    }
  }
  writeFileSync(join(dir, 'rebase.bundle'), Buffer.from(result.bundle, 'base64'));
  must('fetch', '-q', join(dir, 'rebase.bundle'), '+refs/heads/bot-rebased/*:refs/rebased/*');

  const rebased = new Map();
  for (const l of stack) {
    const sha = git('rev-parse', '--verify', '-q', `refs/rebased/${l.headRef}`).stdout.trim();
    const onto = l.parent ? rebased.get(l.parent) : must('rev-parse', `origin/${result.baseRef}`);
    if (!sha || !onto || git('merge-base', '--is-ancestor', onto, sha).status !== 0) continue;
    rebased.set(l.headRef, sha);
  }
  const changed = stack.filter(l => rebased.has(l.headRef) && rebased.get(l.headRef) !== l.headSha);
  if (!changed.length) {
    if (note) await comment(note);
    await unlabelAll();
    summary(`#${number} is already up to date with ${result.baseRef}`);
    return;
  }
  const push = git('push', '-q', '--atomic',
    ...changed.map(l => `--force-with-lease=refs/heads/${l.headRef}:${l.headSha}`),
    'origin', ...changed.map(l => `${rebased.get(l.headRef)}:refs/heads/${l.headRef}`));
  await unlabelAll();
  if (push.status !== 0) {
    const err = push.stderr.replaceAll(auth, '***');
    // The app can't push commits that change workflows; otherwise a branch
    // moved since the request, and whoever moved it wins.
    if (/workflow/i.test(err)) {
      await comment('Rebased, but I can\'t push commits that change workflows, so this needs a manual rebase.');
    }
    throw new Error(`push failed: ${err}`);
  }
  await unstackIfLast(stack.find(l => !l.parent).number);
  if (result.retarget) {
    const bottom = stack.find(l => !l.parent);
    const res = await gh(`/repos/${repo}/pulls/${bottom.number}`, { method: 'PATCH', body: { base: result.retarget }, raw: true });
    if (!res.ok) console.log(`Moving #${bottom.number} onto ${result.retarget}: ${res.status} ${await res.text()}`);
  }

  for (const layer of output.layers ?? []) {
    const l = changed.find(c => c.number === layer.number);
    if (!l) continue;
    for (const c of layer.conflicts ?? []) console.log(`#${l.number} ${c.path}: ${c.resolution}`);
    if (layer.tests) console.log(`#${l.number} tested: ${layer.tests}`);
    const decisions = (layer.decisions ?? []).filter(d => d.trim());
    if (!decisions.length) continue;
    const pr = await gh(`/repos/${repo}/pulls/${l.number}`);
    if (pr.auto_merge) {
      await graphql(
        `mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: pr.node_id }
      );
    }
    await gh(`/repos/${repo}/issues/${l.number}/comments`, {
      method: 'POST',
      body: {
        body: clean(
          `Rebased onto \`${result.baseRef}\`. Resolving the conflicts took decisions worth checking:\n\n` +
            decisions.map(d => `- ${d}`).join('\n') +
            (pr.auto_merge ? '\n\nI turned off auto-merge, since the approval predates these; re-approve to merge.' : '')
        ),
      },
    });
    await gh(`/repos/${repo}/issues/${l.number}/labels`, { method: 'POST', body: { labels: ['bot-review'] } });
  }
  if (note) await comment(note);
  summary(`Rebased ${changed.map(l => `#${l.number}`).join(', ')} onto ${result.baseRef}`);
}
