# wasm-bindgen-bot

Automated PR review, issue triage, bug reproduction and PRs for repositories in the
[wasm-bindgen](https://github.com/wasm-bindgen) organization, run by Claude
Code through Cloudflare AI Gateway.

Each run has two jobs:

- **analyze** collects the PR or issue into files, then runs Claude Code in
  `--bare` mode, so nothing in the checkout can configure it, with a GET-only
  GitHub API tool for public data. For reviews and triage it only has `Read`,
  `Grep` and `Glob` confined to that directory. Investigations and PRs also
  get `Bash`, `Edit` and `Write`, and run as an unprivileged sandbox user
  with no sudo. The AI Gateway token and the read-only `GITHUB_TOKEN` stay in
  helper processes that the sandbox user can't inspect, which add the tokens
  to its requests on localhost. It uploads the model's structured output, plus
  the changed files for a PR.
- **post** validates that output and posts it as the `wasm-bindgen-bot` app: a
  single review anchored to diff lines, existing labels and a comment on an
  issue, or a branch and PR built from the changed files through the Git
  Data API. Reviews are comments or approvals, never change requests. It holds
  an app token scoped to issues, pull requests and contents (which GitHub
  requires to resolve review threads), and never runs a model.

A review is only posted if the PR head hasn't moved since it was analyzed, so
runs superseded by a newer push never post. The bot may approve any PR, which
never lands anything by itself, and when there is nothing to add it approves
without a comment. Otherwise it lists what it wants changed under "Requesting
changes", though the review itself is never a blocking change request. Set
the `post` action's `approve` input to `collaborators` or `never` to restrict
approvals.

Collaborators are users with the maintain or admin role on the repository,
which the org's `collaborators` team grants; the core team are the org owners
(admin). This is read from the
permission API, since `author_association` hides private org membership from
Actions tokens.

PR code is never built or executed, which is what makes `pull_request_target`
safe for fork PRs. Same-repo PRs use `pull_request` instead. Only
investigations and PRs run code, from the default branch and the issue, and
only at a collaborator's request. Branch protection on the default branch is
what guards the app's write access.

## Commands

Collaborators run each command by commenting `@wbg-bot <command>` (or
`@wasm-bindgen-bot <command>`) or by adding the `bot-<command>` label, which
the bot removes afterwards. Text after a comment command is passed to the
model as a request, for example `@wbg-bot review focus on the unsafe blocks`.
Any other comment to the bot, such as `@wbg-bot what happens here if the
closure is dropped?`, is a question, which it answers read-only with the
context a review or triage would have. In a review thread on a same-repo
PR, it answers in the thread.

- `review` (PRs): runs on open and ready for review, skipping drafts and
  bots, and on every push to collaborators' PRs. Use the command to review
  third-party PRs again. Later reviews are re-reviews: the model sees its
  previous review, the changes since and the review threads, and resolves
  its own threads once they are addressed.
- `triage` (issues): runs on every new issue. Adds labels, and
  `ready-for-pr` when the issue has a clear goal and a settled, well-defined
  design space; otherwise it removes `ready-for-pr` and comments on what
  remains unresolved. Closes issues, with a short comment, that are confirmed
  fixed, duplicates, or clearly spam or off topic.
- `investigate` (issues): clones the repository and tries to reproduce the
  issue, then comments with a minimal reproduction or what it tried, and
  labels or closes it as triage does. When the issue is ready for a PR, it
  adds `bot-pr`, so its comment becomes the PR's brief. Only triage sets
  `ready-for-pr`.
- `pr` (issues and the bot's own PRs): on an issue, implements it, or the
  request in the comment, builds and tests it, and opens a PR from a
  `wbg-bot/issue-<n>` branch. On one of the bot's PRs, addresses the open
  review feedback with a new commit, never a force push, and replies in the
  threads it handled. Changes to workflows are dropped, since the app can't
  push them.

Anyone can comment on bot PRs, but the runs that review and update them only
see comments from collaborators and the bot itself. The bot reviews each one
after every push. While it has concerns it adds
`bot-pr` to send the PR back, for up to three rounds, after which it leaves
the PR to a human. GitHub doesn't let the app approve its own PRs, so once it has no
concerns it adds `merge-ready` instead, and removes it again if a later
review finds some. A human approval is always needed.

Investigations and PRs for issues run code, so they only see the issue as it
was when a collaborator asked for them: later comments and edits by anyone
else are left out.

- `rebase` (PRs): rebases a same-repo PR onto its base with plain git, no
  model, and force-pushes it only if nobody pushed meanwhile. A PR in a
  stack, whose base is another open PR's branch, is rebased with its whole
  stack, bottom up, in one atomic push; a request on a layer above one that
  is already being rebased is skipped. Conflicts are never resolved: it
  comments with the conflicting files instead. The bot's own pushes don't
  trigger re-reviews.

A collaborator's approval of a same-repo PR also enables squash auto-merge,
unless the PR is a draft or labelled "do not land", so it lands once checks
pass. Approvals by the bot itself never do. Auto-merge has to be allowed in
the repository settings.

All of them weigh the discussion by project role: core team members vote on
direction and collaborators review, so their positions settle points over
those of other participants.

## Setup

The organization provides `CF_AIG_TOKEN` and `WASM_BINDGEN_BOT_PRIVATE_KEY`
secrets and `CF_ACCOUNT_ID`, `CF_GATEWAY_ID` and `WASM_BINDGEN_BOT_APP_ID`
variables to each enabled repository, and the app must be installed on it.
Create `bot-review`, `bot-triage`, `bot-investigate`, `bot-pr`, `bot-rebase`, `ready-for-pr` and `merge-ready` labels,
then add `.github/workflows/bot.yml`:

```yaml
name: wasm-bindgen-bot

# Same-repo PRs use pull_request, since their authors already have write
# access. Fork PRs use pull_request_target, which is safe because the bot only
# reads PR content and never runs it.
on:
  pull_request:
    types: [opened, ready_for_review, synchronize, labeled]
  pull_request_target:
    types: [opened, ready_for_review, synchronize, labeled]
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]
  # Only same-repo PRs, since GitHub gives fork PRs' review comment runs no
  # secrets.
  pull_request_review_comment:
    types: [created]
  # Likewise same-repo only: a collaborator's approval enables auto-merge.
  pull_request_review:
    types: [submitted]

permissions: {}

jobs:
  analyze:
    # Pushes to PRs by non-collaborators and commands from non-collaborators
    # are skipped by the analyze action, which checks repository roles.
    if: >-
      (((github.event_name == 'pull_request' &&
          github.event.pull_request.head.repo.full_name == github.repository) ||
        (github.event_name == 'pull_request_target' &&
          github.event.pull_request.head.repo.full_name != github.repository)) && (
        (github.event.action == 'labeled' && startsWith(github.event.label.name, 'bot-')) ||
        (github.event.action != 'labeled' && !github.event.pull_request.draft &&
          github.event.pull_request.user.type != 'Bot'))) ||
      (github.event_name == 'issues' && (
        (github.event.action == 'opened' && github.event.issue.user.type != 'Bot') ||
        (github.event.action == 'labeled' && startsWith(github.event.label.name, 'bot-')))) ||
      ((github.event_name == 'issue_comment' ||
        (github.event_name == 'pull_request_review_comment' &&
          github.event.pull_request.head.repo.full_name == github.repository)) &&
        (startsWith(github.event.comment.body, '@wasm-bindgen-bot ') ||
          startsWith(github.event.comment.body, '@wbg-bot '))) ||
      (github.event_name == 'pull_request_review' &&
        github.event.review.state == 'approved' &&
        github.event.review.user.type != 'Bot' &&
        github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    timeout-minutes: 100
    concurrency:
      # Comment and approval runs start before the bot checks who wrote them,
      # so they get their own group rather than cancelling reviews in progress.
      group: wasm-bindgen-bot-${{ github.event.pull_request.number || github.event.issue.number }}${{ github.event.comment && format('-{0}', github.event.comment.id) || github.event.review && format('-review-{0}', github.event.review.id) || '' }}
      cancel-in-progress: true
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: wasm-bindgen/wasm-bindgen-bot/analyze@main
        with:
          cf-aig-token: ${{ secrets.CF_AIG_TOKEN }}
          cf-account-id: ${{ vars.CF_ACCOUNT_ID }}
          cf-gateway-id: ${{ vars.CF_GATEWAY_ID }}

  post:
    needs: analyze
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - uses: wasm-bindgen/wasm-bindgen-bot/post@main
        with:
          app-id: ${{ vars.WASM_BINDGEN_BOT_APP_ID }}
          private-key: ${{ secrets.WASM_BINDGEN_BOT_PRIVATE_KEY }}
```

Callers track `main`, so changes here roll out to every repository at once.

The repository's `AGENTS.md`, describing its layout and conventions, is read
from the base branch and included in the prompt. Notes meant only for the bot
can go in an optional `.github/bot.md`.

`analyze` also accepts `review-model`, `triage-model`, `review-effort`,
`triage-effort`, `max-budget-usd` and `claude-code-version` inputs.
