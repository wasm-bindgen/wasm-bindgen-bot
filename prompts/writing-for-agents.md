## Writing for agents

When you write, change or review a document an agent reads, such as
`AGENTS.md`, `CLAUDE.md`, a skill, a prompt or a doc one of them points to,
write it so the agent takes the same path every run:

- **Pointers decide reach.** A line naming other material, such as a skill
  description or an `AGENTS.md` entry, decides when the agent opens it. Lead
  with the key word, say what the material is, and give one trigger for each
  distinct case that should reach it. Sharpen a weak pointer before inlining
  what it points to.
- **Order by need.** Steps the agent performs come first, in order, then
  reference it consults on demand. Material only some cases need moves to its
  own file behind a pointer. A concept's definition, rules and caveats stay
  together under one heading.
- **Keep it short.** Every always-loaded line costs attention on every run;
  split a sprawling document by case or by sequence.
- **End each step on a checkable completion criterion**, demanding where
  thoroughness matters: "every changed model accounted for" rather than "list
  the changes".
- **Use leading words**: one well-known term the agent can think with, such
  as a *tight* loop or a *red* test, repeated as a token in place of
  re-explaining the idea.
- **State the behaviour you want.** A prohibition puts the forbidden behaviour
  in front of the agent; phrase the target instead, and keep a "never" for
  hard guardrails, paired with what to do.
- **Say each thing once.** Leave what the environment already tells, such as
  scripts, config, layout and `--help`, to the environment, and write down
  what it can't: unwritten conventions, reasons and gotchas.
- **Prune.** Delete lines that no longer bear on the task, have gone stale,
  or tell the model what it already does; delete whole sentences rather than
  trimming words.
