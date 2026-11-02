# gh-issues

A Claude Code plugin for GitHub issues: a pane beside the chat that lists the issues of the
current repository, shows an issue with its comments, and creates, comments on, closes and
reopens issues. *Work on this issue* hands the issue to Claude as a prompt. A bundled skill
covers the same operations for plain-language requests in the chat.

All GitHub access goes through the [GitHub CLI](https://cli.github.com/) (`gh`), so no token
setup is required beyond `gh auth login`.

## Install

```
/plugin install gh-issues --marketplace Jajaho/claude-gh-issues
```

Requirements: `gh` on the `PATH`, logged in with `repo` scope; a session started inside a
clone of a GitHub repository.

## Use

| Command | Effect |
|---|---|
| `/issues` | Opens the pane with the open issues of the current repository |
| `/issues 42` | Opens issue #42 |
| `/issues new` | Opens the form for a new issue |

In the pane:

- **List**: *Show* filters by open, assigned to me, created by me, closed or all. Click an
  issue (or Tab to it and press Enter) to open it. Hotkeys: `r` refresh, `n` new issue.
- **Issue**: title, state, labels, body and comments as Markdown. *Comment* posts the text on
  Enter. *Close as completed*, *Close as not planned* and *Reopen* change the state.
  *Work on this issue* (`w`) submits a prompt that has Claude read the issue, follow the
  repository's CLAUDE.md branch and commit rules, implement, test and commit, without pushing.
  Hotkeys: `b` back, `r` refresh, `c` close.
- **New issue**: title, Markdown description and an optional label; Enter in the description
  or *Create issue* creates it and opens it.

The pane has keyboard focus after `/issues`; otherwise give it focus with the focus chord or
a click. Esc returns to the prompt.

## Development

```
claude --plugin-dir path/to/claude-gh-issues
claude plugin validate path/to/claude-gh-issues
claude plugin test path/to/claude-gh-issues
```

## License

MIT
