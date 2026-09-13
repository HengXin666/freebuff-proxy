<!-- Copy into the ROOT AGENTS.md / CLAUDE.md of the target project. Replace <notes-root> and
     <skill-path> with the real paths.
     Put it in the root file, not in <notes-root>/AGENTS.md: nothing loads that file on its own.
     An agent reaches the notes only because the root instruction file points at them.
     This is the behavioural half; the scripts are the mechanical half, and neither
     replaces the other. -->

## Decision records live in <notes-root>

A change is non-trivial when it alters behavior, architecture, a contract shared across
files or packages, process or tooling, testing strategy, or an on-disk, wire, or
configuration format. Every non-trivial change adds or updates one Agent Note in the
same commit; a purely mechanical local edit is exempt.

1. Before changing a declaration, look for the note cited beside it — a path under
   <notes-root>, usually in a comment or JSDoc clause. Read it first: it records what was
   already rejected and why.
2. Prefer updating the note that already owns the decision. Rewrite stale facts in place;
   do not append change history, and never rewrite a note into a different decision —
   supersede it and cross-link both.
3. A new direction starts in `<notes-root>/proposed/{class}/`; on landing it becomes
   `implemented/{class}/` in the same commit, stated in the present tense, and cited from the
   code it governs (see item 1). Cite it once, where a reader would otherwise remove the
   constraint.
4. Every active note carries `## Alternatives considered`, including a "do nothing or
   reuse" option, each rival given its strongest argument before it is dismissed.
5. When a note is fully superseded, move it with `notes:archive`; when a rejected
   proposal no longer prevents a plausible mistake, delete it.

Run `npm run verify-notes` before pushing. A guarded source change with no note in the
same change fails CI; to exempt one deliberately, write <notes-root>/NOTE-EXEMPT.md containing
`note-exempt: <why this change needs no note>`.
