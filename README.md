# wasm-bindgen-bot

Automated PR review and issue triage for repositories in the
[wasm-bindgen](https://github.com/wasm-bindgen) organization, run by Claude
Code through Cloudflare AI Gateway.

Each run has two jobs:

- **analyze** collects the PR or issue into files, then runs Claude Code with
  only `Read`, `Grep` and `Glob` confined to that directory, in `--bare` mode so
  nothing in the checkout can configure it. It holds the AI Gateway token and a
  read-only `GITHUB_TOKEN`, and uploads the model's structured output.
- **post** validates that output and posts it as the `wasm-bindgen-bot` app: a
  single review anchored to diff lines, or existing labels and a comment on an
  issue. Reviews are comments or approvals, never change requests. It holds
  an app token scoped to issues, pull requests and contents (which GitHub
  requires to resolve review threads), and never runs a model.

Approval is limited to the analyzed head commit and, by default, to PRs from
collaborators. Set the `post` action's `approve` input to `all` or `never` to
change that.

Collaborators are users with the maintain or admin role on the repository,
which the org's `collaborators` team grants. This is read from the
permission API, since `author_association` hides private org membership from
Actions tokens.

PR code is never built or executed, which is what makes `pull_request_target`
safe for fork PRs.

## Triggers

- PRs: on open and ready for review, skipping drafts and bots. PRs from
  collaborators are also re-reviewed on every push.
- Adding the `request-review` label to a PR runs a review, and the bot
  removes the label afterwards. Use it to re-review third-party PRs.
- Later reviews are re-reviews: the model sees its previous review, the
  changes since, and the review threads, and resolves its own threads once
  they are addressed.
- Issues: on open.
- Collaborators can also comment
  `@wasm-bindgen-bot review` on a PR or `@wasm-bindgen-bot triage` on an
  issue to rerun it. Text after the command is passed to the model as a
  request, for example `@wasm-bindgen-bot review focus on the unsafe blocks`.

## Setup

The organization provides `CF_AIG_TOKEN` and `WASM_BINDGEN_BOT_PRIVATE_KEY`
secrets and `CF_ACCOUNT_ID`, `CF_GATEWAY_ID` and `WASM_BINDGEN_BOT_APP_ID`
variables to each enabled repository, and the app must be installed on it.
Create a `request-review` label, then add `.github/workflows/bot.yml`:

```yaml
name: wasm-bindgen-bot

on:
  pull_request_target:
    types: [opened, ready_for_review, synchronize, labeled]
  issues:
    types: [opened]
  issue_comment:
    types: [created]

permissions: {}

jobs:
  analyze:
    if: >-
      (github.event_name == 'pull_request_target' && (
        (github.event.action == 'labeled' && github.event.label.name == 'request-review') ||
        (!github.event.pull_request.draft && github.event.pull_request.user.type != 'Bot' && (
          github.event.action == 'opened' || github.event.action == 'ready_for_review' ||
          github.event.action == 'synchronize')))) ||
      (github.event_name == 'issues' && github.event.issue.user.type != 'Bot') ||
      (github.event_name == 'issue_comment' &&
        (startsWith(github.event.comment.body, '@wasm-bindgen-bot review') ||
          startsWith(github.event.comment.body, '@wasm-bindgen-bot triage')))
    runs-on: ubuntu-latest
    timeout-minutes: 20
    concurrency:
      group: wasm-bindgen-bot-${{ github.event.pull_request.number || github.event.issue.number }}
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

Optionally add `.github/bot.md` describing the repository's layout and review
conventions. It is read from the base branch and included in the prompt.

`analyze` also accepts `review-model`, `triage-model`, `review-effort`,
`triage-effort`, `max-budget-usd` and `claude-code-version` inputs.
