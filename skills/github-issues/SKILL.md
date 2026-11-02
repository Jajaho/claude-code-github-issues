---
name: github-issues
description: View, create, comment on, label, assign, close, reopen and work on GitHub issues of the current repository with the gh CLI. Use when the user mentions an issue number (#42), asks to list or show issues or bugs, file or open an issue, comment on, close or reopen one, or to work on / fix / implement an issue.
---

# GitHub issues with gh

All commands run in the repository's working directory; `gh` resolves the repository from the
`origin` remote. Add `--repo owner/name` when the user names another repository.

## Read

- List: `gh issue list --state open --limit 30` (`--assignee @me`, `--author @me`,
  `--label bug`, `--search "text"`, `--state closed|all`).
- Show: `gh issue view 42 --comments`. For structured fields:
  `gh issue view 42 --json number,title,body,state,labels,assignees,comments,url`.

Summarise lists as a short table (number, title, labels, assignee, updated); do not paste raw
JSON.

## Write

Pass multi-line text through stdin with `--body-file -` (a heredoc), never inline `--body`
with shell-escaped Markdown.

- Create: `gh issue create --title "…" --body-file - [--label bug] [--assignee @me]`
- Comment: `gh issue comment 42 --body-file -`
- Close: `gh issue close 42 --reason completed` (or `"not planned"`); optional `--comment "…"`
- Reopen: `gh issue reopen 42`
- Labels and assignees: `gh issue edit 42 --add-label x --remove-label y --add-assignee @me`

Creating, commenting on, closing and reopening are visible to everyone with access to the
repository. Show the title and body (or the comment) and get confirmation before posting,
unless the user gave the exact text or explicitly asked to post without review. Never close an
issue as a side effect of other work.

## Work on an issue

1. `gh issue view N --comments` and read the linked code.
2. Follow the repository's CLAUDE.md rules for branches and commits. Where none exist,
   create `issue-N-<short-slug>` from the default branch.
3. Plan; for a non-trivial change, state the plan before editing.
4. Implement, run the relevant tests, commit with `#N` in the message (`Fixes #N` only when
   the user wants the merge to close it).
5. Do not push, open a pull request, comment on or close the issue unless asked. Report what
   is ready.

## Pane

The plugin also provides the `/issues` pane (`/issues 42`, `/issues new`). Suggest it when the
user wants to browse issues.
