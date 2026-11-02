import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IssueDetail, IssueDraft, IssueFilter, IssueRow, IssueView, RepoInfo } from '../types'
import {
  issueClose,
  issueComment,
  issueCreate,
  issueList,
  issueReopen,
  issueView,
  labelList,
  repoView,
} from './gh'

const PANE = 'gh-issues'
const TITLE = 'GitHub issues'

const repoA = atom({ plugin: 'gh-issues', key: 'repo' } as const, null, { shape: 'repo-1' })
const viewA = atom({ plugin: 'gh-issues', key: 'view' } as const, 'list')
const filterA = atom({ plugin: 'gh-issues', key: 'filter' } as const, 'open')
const issuesA = atom({ plugin: 'gh-issues', key: 'issues' } as const, [], { shape: 'issues-1' })
const detailA = atom({ plugin: 'gh-issues', key: 'detail' } as const, null, { shape: 'detail-1' })
const busyA = atom({ plugin: 'gh-issues', key: 'busy' } as const, '')
const errorA = atom({ plugin: 'gh-issues', key: 'error' } as const, '')
const EMPTY_DRAFT: IssueDraft = { title: '', body: '', label: '' }
const draftA = atom({ plugin: 'gh-issues', key: 'draft' } as const, EMPTY_DRAFT, { shape: 'draft-1' })
const commentA = atom({ plugin: 'gh-issues', key: 'comment' } as const, '')
const labelsA = atom({ plugin: 'gh-issues', key: 'labels' } as const, [], { shape: 'labels-1' })

const FILTERS: { value: IssueFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'authored', label: 'Created by me' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]
const NO_LABEL = '(no label)'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Runs one gh action with a busy marker; a failure is shown in the pane and the status line. */
async function act($: EngineInterface, doing: string, work: () => Promise<void>): Promise<boolean> {
  await update($, busyA, () => doing)
  await update($, errorA, () => '')
  try {
    await work()
    return true
  } catch (err) {
    await update($, errorA, () => `${doing}: ${message(err)}`)
    return false
  } finally {
    await update($, busyA, () => '')
  }
}

async function ensureRepo($: EngineInterface): Promise<RepoInfo | null> {
  const known = await read($, repoA)
  if (known) return known
  let found: RepoInfo | null = null
  await act($, 'reading repository', async () => {
    found = await repoView($)
    await update($, repoA, () => found)
  })

  return found
}

async function loadList($: EngineInterface): Promise<void> {
  const repo = await ensureRepo($)
  if (!repo) return
  const filter = await read($, filterA)
  await act($, 'loading issues', async () => {
    const got = await issueList($, repo.nameWithOwner, filter)
    await update($, issuesA, () => got)
  })
}

async function openIssue($: EngineInterface, number: number): Promise<void> {
  const repo = await ensureRepo($)
  if (!repo) return
  const current = await read($, detailA)
  if (current?.number !== number) {
    await update($, detailA, () => null)
    await update($, commentA, () => '')
  }
  await update($, viewA, () => 'detail')
  await act($, `loading #${number}`, async () => {
    const got = await issueView($, repo.nameWithOwner, number)
    await update($, detailA, () => got)
  })
}

async function openNew($: EngineInterface): Promise<void> {
  await update($, viewA, () => 'new')
  const repo = await ensureRepo($)
  if (!repo || (await read($, labelsA)).length > 0) return
  await act($, 'loading labels', async () => {
    const got = await labelList($, repo.nameWithOwner)
    await update($, labelsA, () => got)
  })
}

async function submitComment($: EngineInterface, number: number, text: string): Promise<void> {
  const repo = await read($, repoA)
  if (!repo || !text.trim()) return
  const ok = await act($, `commenting on #${number}`, () =>
    issueComment($, repo.nameWithOwner, number, text),
  )
  if (!ok) return
  await update($, commentA, () => '')
  void $.ui.toast(`#${number}: comment added`)
  await openIssue($, number)
}

async function setState(
  $: EngineInterface,
  number: number,
  to: 'completed' | 'not planned' | 'reopen',
): Promise<void> {
  const repo = await read($, repoA)
  if (!repo) return
  const ok = await act($, to === 'reopen' ? `reopening #${number}` : `closing #${number}`, () =>
    to === 'reopen'
      ? issueReopen($, repo.nameWithOwner, number)
      : issueClose($, repo.nameWithOwner, number, to),
  )
  if (!ok) return
  void $.ui.toast(to === 'reopen' ? `#${number}: reopened` : `#${number}: closed as ${to}`)
  await openIssue($, number)
  await loadList($)
}

async function createIssue($: EngineInterface): Promise<void> {
  const repo = await ensureRepo($)
  const draft = await read($, draftA)
  if (!repo) return
  if (!draft.title.trim()) {
    await update($, errorA, () => 'new issue: title is empty')
    return
  }
  let number = 0
  const ok = await act($, 'creating issue', async () => {
    number = await issueCreate($, repo.nameWithOwner, draft.title.trim(), draft.body, draft.label)
  })
  if (!ok) return
  await update($, draftA, () => EMPTY_DRAFT)
  void $.ui.toast(`#${number}: created`)
  await openIssue($, number)
  await loadList($)
}

function workPrompt(repo: string, d: IssueDetail): string {
  return [
    `Work on GitHub issue #${d.number} of ${repo}: "${d.title}" (${d.url}).`,
    `Read it with \`gh issue view ${d.number} --repo ${repo} --comments\`.`,
    `Follow this repository's CLAUDE.md rules for branches and commits; where none exist, create a branch named issue-${d.number}-<short-slug> from the default branch.`,
    `Plan the change, implement it, run the relevant tests and commit, with "#${d.number}" in the commit message.`,
    `Do not push, open a pull request, comment on or close the issue unless asked.`,
  ].join('\n')
}

const ago = (iso: string): string => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  return iso.slice(0, 10)
}

async function openPane($: EngineInterface, focus: boolean) {
  return $.ui.open({ id: PANE, title: TITLE, ...(focus ? { focus: true } : {}) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issues',
      description: 'Open the GitHub issues pane; with an issue number, open that issue',
      argumentHint: '[number | new]',
    })

    return next(e)
  })

  on('command.run', { command: 'issues' }, async ($, e) => {
    const arg = e.args.trim().replace(/^#/, '')
    await openPane($, true)
    if (/^\d+$/.test(arg)) {
      await openIssue($, Number(arg))
    } else if (arg === 'new') {
      await openNew($)
    } else {
      await update($, viewA, () => 'list')
      await loadList($)
    }
    const err = await read($, errorA)

    return { text: err ? `GitHub issues pane: ${err}` : 'GitHub issues pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button, Link, Markdown } = t
    const Input = 'Input' in t ? t.Input : undefined
    const Select = 'Select' in t ? t.Select : undefined
    const width = e.props.bodyColumns

    const repo = await read($, repoA)
    const view = await read($, viewA)
    const busy = await read($, busyA)
    const error = await read($, errorA)

    const status = (
      <Box flexDirection="column">
        {busy && <Text dimColor>{busy} …</Text>}
        {error && <Text color="red">{error}</Text>}
      </Box>
    )

    if (!repo) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>No GitHub repository is known for this directory.</Text>
          {status}
          <Button key="retry" onPress={() => void loadList($)}>Retry</Button>
        </Box>
      )
    }

    if (view === 'detail') {
      const d = await read($, detailA)
      const comment = await read($, commentA)
      const header = (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="back" hotkey="b" onPress={() => void update($, viewA, () => 'list')}>
            Back
          </Button>
          {d && (
            <Button key="reload" hotkey="r" onPress={() => void openIssue($, d.number)}>
              Refresh
            </Button>
          )}
        </Box>
      )
      if (!d) {
        return (
          <Box flexDirection="column" gap={1}>
            {header}
            {status}
          </Box>
        )
      }
      const isOpen = d.state === 'OPEN'
      const reason = d.stateReason ? ` (${d.stateReason.toLowerCase().replace('_', ' ')})` : ''

      return (
        <Box flexDirection="column" gap={1} width={width}>
          {header}
          <Box flexDirection="column">
            <Text bold>
              #{d.number} {d.title}
            </Text>
            <Text dimColor>
              <Text color={isOpen ? 'green' : 'magenta'}>{d.state.toLowerCase()}{reason}</Text>
              {' · '}opened by {d.author} {ago(d.createdAt)} ago · {d.comments.length} comments
            </Text>
            {d.labels.length > 0 && <Text color="cyan">{d.labels.join(', ')}</Text>}
            {d.assignees.length > 0 && <Text dimColor>assigned: {d.assignees.join(', ')}</Text>}
            <Link href={d.url} label="Open on GitHub" />
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button
              key="work"
              hotkey="w"
              variant="primary"
              onPress={() => {
                void $.prompt.submit({ text: workPrompt(repo.nameWithOwner, d) })
                void $.ui.toast(`#${d.number}: handed to Claude`)
              }}
            >
              Work on this issue
            </Button>
            {isOpen ? (
              <>
                <Button key="close" hotkey="c" onPress={() => void setState($, d.number, 'completed')}>
                  Close as completed
                </Button>
                <Button key="close-np" onPress={() => void setState($, d.number, 'not planned')}>
                  Close as not planned
                </Button>
              </>
            ) : (
              <Button key="reopen" hotkey="o" onPress={() => void setState($, d.number, 'reopen')}>
                Reopen
              </Button>
            )}
          </Box>
          {status}
          <Markdown text={d.body.trim() || '_No description provided._'} />
          {d.comments.map((c, i) => (
            <Box key={`comment-${i}`} flexDirection="column">
              <Text dimColor>
                ── {c.author} · {ago(c.createdAt)} ago
              </Text>
              <Markdown text={c.body.trim() || '_empty comment_'} />
            </Box>
          ))}
          {Input && (
            <Input
              key="comment"
              label="Comment"
              placeholder="Markdown text; Enter posts the comment"
              rows={4}
              submitLabel="post"
              value={comment}
              onInput={value => void update($, commentA, () => value)}
              onSubmit={value => void submitComment($, d.number, value)}
            />
          )}
        </Box>
      )
    }

    if (view === 'new') {
      const draft = await read($, draftA)
      const labels = await read($, labelsA)
      const patch = (p: Partial<IssueDraft>) => void update($, draftA, old => ({ ...old, ...p }))

      return (
        <Box flexDirection="column" gap={1} width={width}>
          <Text bold>New issue in {repo.nameWithOwner}</Text>
          {Input ? (
            <>
              <Input
                key="new-title"
                label="Title"
                autoFocus
                value={draft.title}
                submitLabel="next"
                onInput={value => patch({ title: value })}
                onSubmit={value => patch({ title: value })}
              />
              <Input
                key="new-body"
                label="Description"
                placeholder="Markdown text"
                rows={8}
                value={draft.body}
                submitLabel="create"
                onInput={value => patch({ body: value })}
                onSubmit={value => {
                  patch({ body: value })
                  void createIssue($)
                }}
              />
            </>
          ) : (
            <Text dimColor>This surface has no text fields; create issues from the terminal or desktop app.</Text>
          )}
          {Select && labels.length > 0 && (
            <Select
              key="new-label"
              label="Label"
              value={draft.label || NO_LABEL}
              options={[NO_LABEL, ...labels].map(value => ({ value }))}
              onSelect={value => patch({ label: value === NO_LABEL ? '' : value })}
            />
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="create" variant="primary" onPress={() => void createIssue($)}>
              Create issue
            </Button>
            <Button key="cancel" onPress={() => void update($, viewA, () => 'list')}>
              Cancel
            </Button>
          </Box>
          {status}
        </Box>
      )
    }

    const filter = await read($, filterA)
    const issues: IssueRow[] = await read($, issuesA)
    const pickFilter = async (value: string) => {
      await update($, filterA, () => value as IssueFilter)
      await loadList($)
    }

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Text bold>{repo.nameWithOwner}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="refresh" hotkey="r" onPress={() => void loadList($)}>
            Refresh
          </Button>
          <Button key="new" hotkey="n" variant="primary" onPress={() => void openNew($)}>
            New issue
          </Button>
        </Box>
        {Select ? (
          <Select
            key="filter"
            label="Show"
            value={filter}
            options={FILTERS}
            onSelect={value => void pickFilter(value)}
          />
        ) : (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {FILTERS.map(f => (
              <Button key={`filter-${f.value}`} dimColor={f.value !== filter} onPress={() => void pickFilter(f.value)}>
                {f.label}
              </Button>
            ))}
          </Box>
        )}
        {status}
        {issues.length === 0 && !busy && <Text dimColor>No issues match this filter.</Text>}
        <Box flexDirection="column">
          {issues.map(issue => (
            <Button key={`issue-${issue.number}`} plain onPress={() => void openIssue($, issue.number)}>
              <Text color={issue.state === 'OPEN' ? 'green' : 'magenta'}>#{issue.number}</Text> {issue.title}
              {issue.labels.length > 0 && <Text color="cyan"> [{issue.labels.join(', ')}]</Text>}
              <Text dimColor>
                {' '}
                · {issue.assignees.length > 0 ? issue.assignees.join(', ') : issue.author} · {ago(issue.updatedAt)}
              </Text>
            </Button>
          ))}
        </Box>
      </Box>
    )
  })
}
