# Issue tracker: Team Task Board + Local Markdown

HackerTube's internal work is tracked in `.scratch/ht-ux/` and mirrored onto the DSH team task board.

## Conventions

- One feature per directory: `.scratch/ht-ux/`
- The spec is `.scratch/ht-ux/spec.md`
- Implementation tickets are one file per ticket at `.scratch/ht-ux/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Each ticket file records `Status: ready-for-agent` and a `Blocked by:` line near the top
- Each ticket has a matching team task created with `team_task_create`; the team task's `blocked_by` mirrors the ticket file's blocking edges
- The team task board is the dispatch surface: teammates claim the task, work in the assigned worktree, and report through the task and message channels
- When a skill says "publish to the issue tracker", write the ticket file and create the matching team task; when it says "fetch the ticket", read the file at the referenced path and the corresponding team task
- Worktree convention: one ticket per branch named `ticket-<NN>-<slug>`, based on the `integration/ht-ux` branch; the Lead merges completed branches into the integration branch before review

## Workflow rules

- Work the frontier: a ticket is ready when every ticket in its `Blocked by` line is complete
- Do not claim a ticket before its blockers are done
- Keep each ticket's write scope as narrow as possible; the ticket file and team task both record it
- Final verification happens on the integration branch, not in individual ticket worktrees
