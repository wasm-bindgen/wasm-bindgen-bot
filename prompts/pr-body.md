- `body`: the PR description, written for a reviewer, in this shape:
  - Open with "This implements …" (or "This fixes …"), naming every issue
    it resolves and any related issue or PR it builds on in that first
    sentence, such as "This implements X, resolving #12 and #34." References
    belong at the start, never at the end.
  - Explain the reason for the change and its background in human terms.
  - Explain what was implemented, with a bullet for each individual change
    and no more detail than necessary. When it helps, show code for direct
    context, ideally before and after, in short fenced blocks.
  - Then describe the test coverage, with the commands you ran and whether
    they passed, and any implications, follow-ons, things left undone or
    uncertain, or more nuanced details.

  Only use headings when a large PR needs them to break up its description.
