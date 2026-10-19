# wasm-bindgen-bot

Automated PR review and issue triage for repositories in the
[wasm-bindgen](https://github.com/wasm-bindgen) organization, run by Claude
Code through Cloudflare AI Gateway.

Each run has two jobs:

- **analyze** collects the PR or issue into files, then runs Claude Code with
  only `Read`, `Grep` and `Glob` confined to that directory, plus a GET-only
  GitHub API tool for public data, in `--bare` mode so nothing in the
  checkout can configure it. It holds the AI Gateway token and a
  read-only `GITHUB_TOKEN`, and uploads the model's structured output.
- **post** validates that output and posts it as the `wasm-bindgen-bot` app: a
  single review anchored to diff lines, or existing labels and a comment on an
  issue. Reviews are comments or approvals, never change requests. It holds
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
safe for fork PRs. Same-repo PRs use `pull_request` instead.

## Triggers

- PRs: on open and ready for review, skipping drafts and bots. PRs from
  collaborators are also re-reviewed on every push.
- Adding the `bot-request-review` label to a PR runs a review, and the bot
  removes the label afterwards. Use it to re-review third-party PRs.
- Later reviews are re-reviews: the model sees its previous review, the
  changes since, and the review threads, and resolves its own threads once
  they are addressed. Points settled by collaborators or core team members
  are treated as decided, weighed by role as in triage.
- Issues: on open, and when the `bot-issue-triage` label is added, which the
  bot removes afterwards. Triage weighs comments by project role (core team
  members vote on direction, collaborators review), and adds `ready-for-pr`
  when the issue has a clear goal and a settled, well-defined design space,
  forming a queue for automated PRs. Otherwise it removes `ready-for-pr` and
  comments on what remains unresolved. It closes issues, with a short
  comment, that are confirmed fixed, duplicates, or clearly spam or off
  topic.
- Collaborators can also comment
  `@wasm-bindgen-bot review` on a PR or `@wasm-bindgen-bot triage` on an
  issue to rerun it, or use the shorter `@wbg-bot` alias. Text after the command is passed to the model as a
  request, for example `@wasm-bindgen-bot review focus on the unsafe blocks`.

## Setup

The organization provides `CF_AIG_TOKEN` and `WASM_BINDGEN_BOT_PRIVATE_KEY`
secrets and `CF_ACCOUNT_ID`, `CF_GATEWAY_ID` and `WASM_BINDGEN_BOT_APP_ID`
variables to each enabled repository, and the app must be installed on it.
Create `bot-request-review`, `bot-issue-triage` and `ready-for-pr` labels,
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
      (github.event_name == 'issue_comment' &&
        (startsWith(github.event.comment.body, '@wasm-bindgen-bot ') ||
          startsWith(github.event.comment.body, '@wbg-bot ')))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      # Comment runs start before the bot checks the commenter, so they get
      # their own group rather than cancelling reviews in progress.
      group: wasm-bindgen-bot-${{ github.event.pull_request.number || github.event.issue.number }}${{ github.event_name == 'issue_comment' && format('-{0}', github.event.comment.id) || '' }}
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
