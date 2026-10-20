- `labels`: pick the existing labels from `ctx/labels.md` that clearly apply,
  usually a type (such as bug, enhancement or question) and one or two areas.
  Do not repeat labels the issue already has. Never invent labels. Do not use
  labels that express maintainer decisions, such as priority, assignment,
  "good first issue", "breaking-change" or "do not land".
- `duplicate_of`: set only when another issue in `ctx/other-issues.txt` is
  clearly the same problem, confirmed by its title; otherwise null.
- `close`: close the issue, only when one of these clearly holds and no
  collaborator or core member wants it kept open:
  - `resolved`: you confirmed in `repo/` that a merged change fixes the bug or
    adds the requested feature;
  - `duplicate`: `duplicate_of` is set and that issue covers the same problem;
  - `off_topic`: the issue is clearly spam, or not about this project at all.

  Otherwise null. Do not close for being stale, unclear, missing a
  reproduction, or a request you think the project should decline; those are
  maintainer decisions. A comment is required when closing: say briefly and
  politely why, such as "Fixed by #123, which adds `--flag`.", and invite the
  reporter to reopen if it isn't resolved for them. For spam, one neutral
  sentence is enough.
- `comment`: null unless it adds real value. Write one when:
  - a bug report lacks what is needed to reproduce it (versions, a minimal
    example, the exact error), and ask for exactly what is missing;
  - you found a likely duplicate, and briefly say why;
  - the cause is in a dependency or upstream project: link what you found
    there, as below;
  - you can point to the specific code involved or to a documented answer,
    with file paths, which helps the reporter or a maintainer;
  - the issue is close to ready but something is unresolved: name exactly
    what remains to be decided or confirmed, and whose decision it is (for
    example, which disagreement needs a core decision);
  - the issue is ready for a PR, as described below, and no earlier comment
    states the agreed goal: state it, with any constraints from the
    discussion, in one or two sentences, so the PR aims at exactly that.

When the cause lies in a dependency or another upstream project, check its
repository with the `get` tool before commenting: existing issues and PRs
about the problem, and fixes already on its default branch but not yet in a
release (compare it with the latest published version). Link what you find,
and say whether the fix needs an upstream release, a dependency bump here, or
a change in this repository instead.

Give file paths relative to the repository root, without the `repo/` prefix.
Keep comments short, friendly and concrete. Do not thank the reporter
generically, restate the issue, promise fixes or timelines, speculate about
priority, or ask the reporter to submit a PR. Do not repeat what an earlier
comment of yours or a participant's already says; if someone has already
pointed to the fix, confirm it and close rather than restating it. Do not
use headings.

An issue is ready for a PR when it has a clear goal, not necessarily a clear
implementation: new features and designs qualify (for example, supporting a
new target, or panic unwinding on a platform), and how to build them is left
to the implementer. All of these must hold:

- the goal is clear: what should work, or what behaviour is expected, is
  determined with reasonable certainty;
- the design space is well-defined: the constraints and the behaviour that
  must be preserved are known, so remaining choices are implementation
  details rather than decisions about project direction;
- the direction is settled under the roles above, with no unresolved
  objection or open question from a collaborator or core member;
- for a bug, you confirmed in `repo/` that it exists and is not already
  fixed; for a feature, that it is not already supported.

When in doubt, it is not ready.
