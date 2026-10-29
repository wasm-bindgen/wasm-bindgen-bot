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
runs superseded by a newer push never post. The bot never approves or
requests changes: its reviews are comments, and its verdict is the
`merge-ready` label, added when it has no concerns, and removed when it lists
what it wants changed under "Not merge-ready". A first merge-ready review
leads with ✅, or is just "✅ LGTM"; a merge-ready re-review only adds the
label, plus any inline comments. The `start` job removes the label when a
review starts, so it only ever marks a reviewed head, and its removal turns
auto-merge off until the new head is approved. The label alone never lands anything; with a collaborator's
approval it enables auto-merge. Set the `post` action's `approve` input to
`collaborators` or `never` to restrict whose PRs it marks.

Collaborators are users with the maintain or admin role on the repository,
which the org's `collaborators` team grants; the core team are the org owners
(admin). This is read from the
permission API, since `author_association` hides private org membership from
Actions tokens.

PR code is never built or executed, which is what makes `pull_request_target`
safe for all PRs, including forks. Only
investigations and PRs run code, from the default branch and the issue, and
only at a collaborator's request. Branch protection on the default branch is
what guards the app's write access.

## Commands

Collaborators run each command by commenting `@wbg-bot <command>` (or
`@wasm-bindgen-bot <command>`) or by adding the `bot-<command>` label, which
the bot removes afterwards. Removing the label before the command finishes
cancels it, or for `bot-review` drops its result. The mention can be anywhere in a comment, outside
code and quoted lines, and the rest of the comment after it is the command.
Text after a comment command is passed to the model as a request, for example `@wbg-bot review focus on the unsafe blocks`.
Any other comment to the bot, such as `@wbg-bot what happens here if the
closure is dropped?`, is a question, which it answers read-only with the
context a review or triage would have. In a review thread on a same-repo
PR, it answers in the thread.

- `review` (PRs): runs on open and ready for review, skipping drafts and
  bots, and on every push to collaborators' PRs. Use the command to review
  third-party PRs again. Later reviews are re-reviews: the model sees its
  previous review, the changes since (after a rebase, the PR's commits
  matched up before and after, without the base branch's changes) and the
  review threads, and resolves
  its own threads once they are addressed.
- `triage` (issues and PRs): runs on every new issue. Adds labels, and
  `ready-for-pr` when the issue has a clear goal and a settled, well-defined
  design space; otherwise it removes `ready-for-pr` and comments on what
  remains unresolved. Closes issues, with a short comment, that are confirmed
  fixed, duplicates, or clearly spam or off topic. On a PR, on request, it
  checks whether the default branch already has what the PR does, and closes
  it with a comment when that's resolved, superseded by a merged PR, or the
  PR is stale: over a year without its author and no longer merging.
- `investigate` (issues): clones the repository and tries to reproduce the
  issue, then comments with a minimal reproduction or what it tried, and
  labels or closes it as triage does. When the issue is ready for a PR, it
  adds `bot-pr`, so its comment becomes the PR's brief. Only triage sets
  `ready-for-pr`.
- `pr` (issues and PRs): on an issue, implements it, or the request in the
  comment, builds and tests it, and opens a PR from a `wbg-bot/issue-<n>`
  branch. On a PR, addresses the open review feedback, or on someone else's
  PR the change the request asks for, with a new commit, and replies in the
  threads it handled. When asked to, or when the work needs it, it rebases
  the PR instead, regenerating snapshots and fixing what the new base broke,
  and pushes it like `rebase` does; a rebased PR is then reviewed again. PRs from forks get the commit when
  their author allows edits by maintainers. On someone else's PR, the bot
  turns off auto-merge, since an approval predates its commit. Changes to workflows are dropped, since the app can't
  push them.

Anyone can comment on bot PRs, but the runs that review and update them only
see comments from collaborators and the bot itself. The bot reviews each one
after every push. While it has concerns it adds
`bot-pr` to send the PR back, for up to three rounds, after which it leaves
the PR to a human. Once it has no concerns it adds `merge-ready`, as on any
PR; a human approval is always needed.

Investigations and PRs for issues run code, so they only see the issue as it
was when a collaborator asked for them: later comments and edits by anyone
else are left out.

- `rebase` (PRs): rebases a PR onto its base in the sandbox, including fork
  PRs whose author allows edits by maintainers,
  trying plain git first and handing conflicts to the model, which resolves
  them keeping the intent of both sides, then builds and tests. A PR in a
  stack, whose base is another open PR's branch, is rebased with its whole
  stack, bottom up; a request on a layer above one that is already being
  rebased is skipped. Once the PR below a stack's bottom layer has merged, the
  bottom layer is unstacked: moved onto the default branch, without the
  merged PR's commits, and taken out of its GitHub stack once it is the last
  open PR there. Pins a PR adds to commits of other repositories in the
  organization, such as git dependencies or submodules, are moved in a commit
  on top when the PR they point into was rebased or merged. The rebased branches come back as a git bundle, and
  are force-pushed in one atomic push only if nobody pushed meanwhile.
  Rebases go through without a comment or a review, unless resolving a
  conflict took a judgment call, such as choosing one side's behaviour. Then
  the bot comments with those decisions, turns off auto-merge, since the
  approval predates them, and reviews the PR. The bot's rebases don't
  otherwise trigger re-reviews; its other pushes are reviewed like anyone's.
  When the model handles the rebase, it corrects a PR's description only
  where the rebase made it wrong, such as naming a lower PR that has merged.
- `issue` (issues and PRs, with a request): opens a new issue for a follow-on
  the request describes, written from the discussion and the code, and
  replies with its link, or points to an existing issue that covers it.

After every push to the default branch, open auto-merge PRs and the bot's own
PRs that it left conflicting get `bot-rebase`.

Commands can also be run from the Actions tab with "Run workflow" on the
bot's workflow, choosing the command, the issue or PR number and a request.
Without a number, `pr` opens a PR from the request alone. `issue` always
needs a request.

A collaborator's approval together with the `merge-ready` label enables squash
auto-merge, so the PR lands once checks pass. Approving a labelled PR, or
labelling an approved one, triggers it; approvals by the bot never count, and
drafts, PRs with changes requested and PRs labelled "do not land" are skipped.
The approval has to be of the PR's latest commit: commits pushed after it
need approving again. GitHub gives approval runs on fork PRs no secrets, so each
push to the default branch also catches up PRs that are merge-ready and
approved but not yet auto-merging.
Removing "do not land" from an approved, merge-ready PR enables it too.
Removing `merge-ready` turns auto-merge off again, as the bot's own reviews do
when they find new concerns. A PR whose checks have already passed is merged
directly. GitHub can't auto-merge stacked PRs, so the last open PR of a stack
is unstacked first; earlier layers wait. Auto-merge has to be allowed in the
repository settings.

All of them weigh the discussion by project role: core team members vote on
direction and collaborators review, so their positions settle points over
those of other participants.

Sandbox runs restore a cargo cache of the default branch's dependencies,
built at the sandbox's paths. Only pushes to the default branch build and save
it, once a month and whenever a `Cargo.toml` or `Cargo.lock` changes, so it
only ever holds builds of merged code. A repository can replace the default
`cargo build --workspace --tests` with `.github/wasm-bindgen-bot-warm.sh`.

## Setup

The organization provides `CF_AIG_TOKEN` and `WASM_BINDGEN_BOT_PRIVATE_KEY`
secrets and `CF_ACCOUNT_ID`, `CF_GATEWAY_ID` and `WASM_BINDGEN_BOT_APP_ID`
variables to each enabled repository, and the app must be installed on it.
Create `bot-review`, `bot-triage`, `bot-investigate`, `bot-pr`, `bot-rebase`, `ready-for-pr` and `merge-ready` labels,
and an Actions event policy (Settings → Actions → Policies) scoped to
`.github/workflows/bot.yml` that allows its events: `pull_request_target`, `workflow_dispatch`, `push`, `issues`, `issue_comment`,
`pull_request_review_comment` and `pull_request_review`. Without it, GitHub's
default policy blocks `pull_request_target` in public repositories from
November 2, 2026, so fork PRs would no longer be reviewed. Then add
`.github/workflows/bot.yml`:

```yaml
name: wasm-bindgen-bot

# PRs use pull_request_target, which is safe because the bot only reads PR
# content and never runs it, and which, unlike pull_request, also runs for PRs
# with merge conflicts.
on:
  pull_request_target:
    types: [opened, ready_for_review, synchronize, labeled, unlabeled]
  issues:
    types: [opened, labeled, unlabeled]
  issue_comment:
    types: [created]
  # Only same-repo PRs, since GitHub gives fork PRs' review comment runs no
  # secrets. Like approvals, these don't run on PRs with merge conflicts.
  pull_request_review_comment:
    types: [created]
  # Likewise same-repo only: a collaborator's approval enables auto-merge.
  pull_request_review:
    types: [submitted]
  # After merges, flags auto-merge PRs they left conflicting for a rebase.
  push:
    branches: [main, master]
  # Runs a command from the Actions tab.
  workflow_dispatch:
    inputs:
      command:
        description: Command to run
        type: choice
        options: [pr, investigate, triage, review, rebase, issue]
        default: pr
      number:
        description: Issue or PR number, optional for pr
        required: false
      request:
        description: Instructions for the bot
        required: false

permissions: {}

jobs:
  analyze:
    # Pushes to PRs by non-collaborators and commands from non-collaborators
    # are skipped by the analyze action, which checks repository roles.
    if: >-
      (github.event_name == 'pull_request_target' && (
        (github.event.action == 'labeled' && startsWith(github.event.label.name, 'bot-')) ||
        (github.event.action == 'unlabeled' && startsWith(github.event.label.name, 'bot-') &&
          github.event.label.name != 'bot-review' && github.event.sender.type != 'Bot') ||
        (github.event.label.name == 'merge-ready' &&
          (github.event.action == 'labeled' || github.event.action == 'unlabeled')) ||
        (github.event.label.name == 'do not land' && github.event.action == 'unlabeled') ||
        (github.event.action != 'labeled' && github.event.action != 'unlabeled' &&
          !github.event.pull_request.draft &&
          (github.event.pull_request.user.type != 'Bot' ||
            github.event.pull_request.user.login == 'wasm-bindgen-bot[bot]')))) ||
      (github.event_name == 'issues' && (
        (github.event.action == 'opened' && github.event.issue.user.type != 'Bot') ||
        (github.event.action == 'labeled' && startsWith(github.event.label.name, 'bot-')) ||
        (github.event.action == 'unlabeled' && startsWith(github.event.label.name, 'bot-') &&
          github.event.label.name != 'bot-review' && github.event.sender.type != 'Bot'))) ||
      ((github.event_name == 'issue_comment' ||
        (github.event_name == 'pull_request_review_comment' &&
          github.event.pull_request.head.repo.full_name == github.repository)) &&
        (contains(github.event.comment.body, '@wasm-bindgen-bot') ||
          contains(github.event.comment.body, '@wbg-bot'))) ||
      (github.event_name == 'pull_request_review' &&
        github.event.review.state == 'approved' &&
        github.event.review.user.type != 'Bot' &&
        github.event.pull_request.head.repo.full_name == github.repository) ||
      github.event_name == 'workflow_dispatch' || github.event_name == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 100
    concurrency:
      # Comment, approval and label runs get their own group rather than
      # cancelling reviews in progress, so removing a command's label cancels
      # only its own run. bot-review is a review, so it shares their group, and
      # removing it only drops its result.
      group: wasm-bindgen-bot-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}${{ github.event.comment && format('-{0}', github.event.comment.id) || github.event.review && format('-review-{0}', github.event.review.id) || github.event.label && github.event.label.name != 'bot-review' && format('-{0}', github.event.label.name) || '' }}
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

  # Removes merge-ready while a review runs.
  start:
    if: >-
      github.event_name == 'pull_request_target' && !github.event.pull_request.draft &&
      (github.event.action == 'opened' || github.event.action == 'ready_for_review' ||
        github.event.action == 'synchronize' ||
        (github.event.action == 'labeled' && github.event.label.name == 'bot-review')) &&
      (github.event.pull_request.user.type != 'Bot' ||
        github.event.pull_request.user.login == 'wasm-bindgen-bot[bot]')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: wasm-bindgen/wasm-bindgen-bot/start@main
        with:
          app-id: ${{ vars.WASM_BINDGEN_BOT_APP_ID }}
          private-key: ${{ secrets.WASM_BINDGEN_BOT_PRIVATE_KEY }}

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
