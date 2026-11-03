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
import { imagesToLinks } from './markdown'

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
    // One column of margin either side. Issue rows and filter tabs carry a space of their own so
    // their highlight clears the dot; they sit flush and the rest of the list view is padded to match.
    const outer = Math.max(30, e.props.bodyColumns)
    const width = outer - 2

    const repo = await read($, repoA)
    const view = await read($, viewA)
    const busy = await read($, busyA)
    const error = await read($, errorA)

    const rule = <Text color="subtle">{'─'.repeat(width)}</Text>
    const pad = (node: JSX.Element | null) => (node ? <Box paddingLeft={1}>{node}</Box> : null)
    const status =
      busy || error ? (
        <Box flexDirection="column">
          {busy && (
            <Text color="claude">
              ✻ <Text color="subtle">{busy}…</Text>
            </Text>
          )}
          {error && <Text color="error">✗ {error}</Text>}
        </Box>
      ) : null
    const header = (sub: string) => (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text>
          <Text color="claude">●</Text> <Text bold>{repo?.nameWithOwner ?? 'GitHub issues'}</Text>
        </Text>
        <Text color="subtle">{sub}</Text>
      </Box>
    )

    if (!repo) {
      return (
        <Box flexDirection="column" gap={1} width={outer} paddingX={1}>
          {header('')}
          <Text color="subtle">No GitHub repository is known for this directory.</Text>
          {status}
          <Button key="retry" onPress={() => void loadList($)}>
            Retry
          </Button>
        </Box>
      )
    }

    if (view === 'detail') {
      const d = await read($, detailA)
      const comment = await read($, commentA)
      const nav = (
        <Box flexDirection="row" gap={2}>
          <Button key="back" hotkey="b" plain onPress={() => void update($, viewA, () => 'list')}>
            <Text color="subtle">← Back</Text>
          </Button>
          {d && (
            <Button key="reload" hotkey="r" plain onPress={() => void openIssue($, d.number)}>
              <Text color="subtle">Refresh</Text>
            </Button>
          )}
        </Box>
      )
      if (!d) {
        return (
          <Box flexDirection="column" gap={1} width={outer} paddingX={1}>
            {header('')}
            {nav}
            {status}
          </Box>
        )
      }
      const isOpen = d.state === 'OPEN'
      const notPlanned = d.stateReason === 'NOT_PLANNED'
      const stateText = isOpen ? 'Open' : notPlanned ? 'Closed · not planned' : 'Closed'
      const stateColor = isOpen ? 'success' : notPlanned ? 'subtle' : 'merged'
      const nComments = `${d.comments.length} ${d.comments.length === 1 ? 'comment' : 'comments'}`

      return (
        <Box flexDirection="column" gap={1} width={outer} paddingX={1}>
          {header(`#${d.number}`)}
          {nav}
          <Box flexDirection="column">
            <Text bold>{d.title}</Text>
            <Text>
              <Text color={stateColor}>
                {notPlanned ? '○' : '●'} {stateText}
              </Text>
              <Text color="subtle">
                {`  ${d.author} opened ${ago(d.createdAt)} ago · ${nComments}`}
              </Text>
            </Text>
            {(d.labels.length > 0 || d.assignees.length > 0) && (
              <Text>
                <Text color="suggestion">{d.labels.map(l => `[${l}] `).join('')}</Text>
                {d.assignees.length > 0 && <Text color="subtle">→ {d.assignees.join(', ')}</Text>}
              </Text>
            )}
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
            <Link href={d.url} label="↗ GitHub" />
          </Box>
          {status}
          {rule}
          <Box flexDirection="column">
            <Text>
              <Text color="claude">●</Text> <Text bold>{d.author}</Text>{' '}
              <Text color="subtle">· {ago(d.createdAt)} ago</Text>
            </Text>
            <Box paddingLeft={2}>
              <Markdown text={imagesToLinks(d.body.trim()) || '_No description provided._'} />
            </Box>
          </Box>
          {d.comments.map((c, i) => (
            <Box key={`comment-${i}`} flexDirection="column">
              <Text>
                <Text color="subtle">●</Text> <Text bold>{c.author}</Text>{' '}
                <Text color="subtle">· {ago(c.createdAt)} ago</Text>
              </Text>
              <Box paddingLeft={2}>
                <Markdown text={imagesToLinks(c.body.trim()) || '_empty comment_'} />
              </Box>
            </Box>
          ))}
          {Input && (
            <Box borderStyle="round" borderColor="promptBorder" paddingX={1} width={width}>
              <Input
                key="comment"
                placeholder="Add a comment (Markdown); Enter posts it"
                rows={3}
                submitLabel="post"
                value={comment}
                onInput={value => void update($, commentA, () => value)}
                onSubmit={value => void submitComment($, d.number, value)}
              />
            </Box>
          )}
        </Box>
      )
    }

    if (view === 'new') {
      const draft = await read($, draftA)
      const labels = await read($, labelsA)
      const patch = (p: Partial<IssueDraft>) => void update($, draftA, old => ({ ...old, ...p }))

      return (
        <Box flexDirection="column" gap={1} width={outer} paddingX={1}>
          {header('new issue')}
          {Input ? (
            <>
              <Box flexDirection="column">
                <Text color="subtle">Title</Text>
                <Box borderStyle="round" borderColor="promptBorder" paddingX={1} width={width}>
                  <Input
                    key="new-title"
                    autoFocus
                    placeholder="Short summary"
                    value={draft.title}
                    submitLabel="next"
                    onInput={value => patch({ title: value })}
                    onSubmit={value => patch({ title: value })}
                  />
                </Box>
              </Box>
              <Box flexDirection="column">
                <Text color="subtle">Description</Text>
                <Box borderStyle="round" borderColor="promptBorder" paddingX={1} width={width}>
                  <Input
                    key="new-body"
                    placeholder="Markdown; Enter creates the issue"
                    rows={8}
                    value={draft.body}
                    submitLabel="create"
                    onInput={value => patch({ body: value })}
                    onSubmit={value => {
                      patch({ body: value })
                      void createIssue($)
                    }}
                  />
                </Box>
              </Box>
            </>
          ) : (
            <Text color="subtle">
              This surface has no text fields; create issues from the terminal or desktop app.
            </Text>
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
    const pickFilter = async (value: IssueFilter) => {
      await update($, filterA, () => value)
      await loadList($)
    }
    const filterName = FILTERS.find(f => f.value === filter)?.label.toLowerCase() ?? ''

    return (
      <Box flexDirection="column" gap={1} width={outer} paddingRight={1}>
        {pad(header(`${issues.length} ${filterName}`))}
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          {FILTERS.map(f => (
            <Button key={`filter-${f.value}`} plain onPress={() => void pickFilter(f.value)}>
              {f.value === filter ? (
                <Text color="claude" bold>
                  {' '}
                  <Text underline>{f.label}</Text>{' '}
                </Text>
              ) : (
                <Text color="subtle">{` ${f.label} `}</Text>
              )}
            </Button>
          ))}
        </Box>
        {pad(rule)}
        {pad(status)}
        {issues.length === 0 && !busy && pad(<Text color="subtle">No issues match this filter.</Text>)}
        <Box flexDirection="column">
          {issues.map(issue => {
            const isOpen = issue.state === 'OPEN'
            const who = issue.assignees.length > 0 ? `→ ${issue.assignees.join(', ')}` : issue.author
            const meta = `  ${who} · ${ago(issue.updatedAt)}`
            const labels = issue.labels.map(l => ` [${l}]`).join('')
            const num = `#${issue.number}`
            // ' ● #n title [labels] meta ': a space either side keeps the dot off the edge of the highlight
            const room = outer - 6 - num.length - labels.length - meta.length
            const title =
              room > 8 && issue.title.length > room ? `${issue.title.slice(0, room - 1)}…` : issue.title

            return (
              <Button key={`issue-${issue.number}`} plain onPress={() => void openIssue($, issue.number)}>
                {' '}
                <Text color={isOpen ? 'success' : 'merged'}>●</Text> <Text color="subtle">{num}</Text>{' '}
                {title}
                <Text color="suggestion">{labels}</Text>
                <Text color="subtle">{`${meta} `}</Text>
              </Button>
            )
          })}
        </Box>
        <Box flexDirection="row" gap={1} paddingLeft={1}>
          <Button key="new" hotkey="n" variant="primary" onPress={() => void openNew($)}>
            + New issue
          </Button>
          <Button key="refresh" hotkey="r" onPress={() => void loadList($)}>
            Refresh
          </Button>
        </Box>
      </Box>
    )
  })
}
