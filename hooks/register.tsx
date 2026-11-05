import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  FieldDef,
  IssueDetail,
  IssueDraft,
  IssueFilter,
  IssueRef,
  IssueRow,
  IssueSide,
  RelationKind,
  RepoInfo,
  RepoOptions,
} from '../types'
import {
  issueClose,
  issueComment,
  issueCreate,
  issueDevelop,
  issueEdit,
  issueExtras,
  issueId,
  issueList,
  issueProjects,
  issueReopen,
  issueSetFields,
  issueView,
  labelList,
  milestoneCreate,
  projectList,
  repoOptions,
  repoView,
  scopeHint,
} from './gh'
import type { FieldSet } from './gh'
import { imagesToLinks } from './markdown'

const PANE = 'gh-issues'
const TITLE = 'GitHub issues'

const repoA = atom({ plugin: 'gh-issues', key: 'repo' } as const, null, { shape: 'repo-1' })
const viewA = atom({ plugin: 'gh-issues', key: 'view' } as const, 'list')
const filterA = atom({ plugin: 'gh-issues', key: 'filter' } as const, 'open')
const issuesA = atom({ plugin: 'gh-issues', key: 'issues' } as const, [], { shape: 'issues-1' })
const detailA = atom({ plugin: 'gh-issues', key: 'detail' } as const, null, { shape: 'detail-2' })
const sideA = atom({ plugin: 'gh-issues', key: 'side' } as const, null, { shape: 'side-1' })
const optionsA = atom({ plugin: 'gh-issues', key: 'options' } as const, null, { shape: 'options-1' })
const busyA = atom({ plugin: 'gh-issues', key: 'busy' } as const, '')
const errorA = atom({ plugin: 'gh-issues', key: 'error' } as const, '')
const EMPTY_DRAFT: IssueDraft = {
  title: '',
  body: '',
  labels: [],
  type: '',
  milestone: '',
  projects: [],
  fields: {},
  parent: '',
  blockedBy: [],
  blocking: [],
  branch: false,
}
const draftA = atom({ plugin: 'gh-issues', key: 'draft' } as const, EMPTY_DRAFT, { shape: 'draft-4' })
const commentA = atom({ plugin: 'gh-issues', key: 'comment' } as const, '')
const labelsA = atom({ plugin: 'gh-issues', key: 'labels' } as const, [], { shape: 'labels-1' })
const relationA = atom({ plugin: 'gh-issues', key: 'relation' } as const, 'blockedBy' as RelationKind)
const relationInputA = atom({ plugin: 'gh-issues', key: 'relationInput' } as const, '')
const fieldTextA = atom({ plugin: 'gh-issues', key: 'fieldText' } as const, {}, { shape: 'field-text-1' })
const milestoneInputA = atom({ plugin: 'gh-issues', key: 'milestoneInput' } as const, '')

const FILTERS: { value: IssueFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned to me' },
  { value: 'authored', label: 'Created by me' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]

const RELATIONS: { kind: RelationKind; label: string; add: string; remove: string }[] = [
  { kind: 'parent', label: 'Parent', add: '--parent', remove: '--remove-parent' },
  { kind: 'sub', label: 'Sub-issue', add: '--add-sub-issue', remove: '--remove-sub-issue' },
  { kind: 'blockedBy', label: 'Blocked by', add: '--add-blocked-by', remove: '--remove-blocked-by' },
  { kind: 'blocking', label: 'Blocking', add: '--add-blocking', remove: '--remove-blocking' },
]

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

/**
 * Reads the issue's fields, projects and development after the issue itself. Each part fails on
 * its own: a token without the project scope hides the projects, not the issue.
 */
async function loadSide($: EngineInterface, repo: string, number: number): Promise<void> {
  await update($, busyA, () => `loading details of #${number}`)
  const [extras, projects] = await Promise.allSettled([
    issueExtras($, repo, number),
    issueProjects($, repo, number),
  ])
  const side: IssueSide = {
    number,
    extras: extras.status === 'fulfilled' ? extras.value : null,
    extrasNote: extras.status === 'rejected' ? message(extras.reason) : '',
    projects: projects.status === 'fulfilled' ? projects.value : null,
    projectsNote: projects.status === 'rejected' ? scopeHint(message(projects.reason)) : '',
  }
  await update($, sideA, () => side)
  await update($, busyA, () => '')
}

/** Reads the issue into the pane without changing the view. */
async function loadIssue($: EngineInterface, number: number): Promise<void> {
  const repo = await ensureRepo($)
  if (!repo) return
  const current = await read($, detailA)
  if (current?.number !== number) {
    await update($, detailA, () => null)
    await update($, sideA, () => null)
    await update($, commentA, () => '')
    await update($, fieldTextA, () => ({}))
    await update($, relationInputA, () => '')
  }
  const ok = await act($, `loading #${number}`, async () => {
    const got = await issueView($, repo.nameWithOwner, number)
    await update($, detailA, () => got)
  })
  if (ok) await loadSide($, repo.nameWithOwner, number)
}

async function openIssue($: EngineInterface, number: number): Promise<void> {
  await update($, viewA, () => 'detail')
  await loadIssue($, number)
}

/** Reads what the repository offers to pick from, once per session unless forced. */
async function loadOptions($: EngineInterface, force = false): Promise<void> {
  const repo = await ensureRepo($)
  if (!repo || (!force && (await read($, optionsA)))) return
  await update($, busyA, () => 'loading types, fields, projects and milestones')
  const [base, projects] = await Promise.allSettled([
    repoOptions($, repo.nameWithOwner),
    projectList($, repo.nameWithOwner),
  ])
  if (base.status === 'rejected') {
    await update($, errorA, () => `loading options: ${message(base.reason)}`)
  }
  const options: RepoOptions = {
    ...(base.status === 'fulfilled' ? base.value : { types: null, fields: null, milestones: [] }),
    projects: projects.status === 'fulfilled' ? projects.value : null,
    projectsNote: projects.status === 'rejected' ? scopeHint(message(projects.reason)) : '',
  }
  await update($, optionsA, () => options)
  await update($, busyA, () => '')
}

async function openNew($: EngineInterface): Promise<void> {
  await update($, viewA, () => 'new')
  const repo = await ensureRepo($)
  if (!repo) return
  if ((await read($, labelsA)).length === 0) {
    await act($, 'loading labels', async () => {
      const got = await labelList($, repo.nameWithOwner)
      await update($, labelsA, () => got)
    })
  }
  await loadOptions($)
}

async function openEdit($: EngineInterface): Promise<void> {
  await update($, viewA, () => 'edit')
  await loadOptions($)
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

/** One `gh issue edit` from the edit view; the view stays and the issue is read again. */
async function editIssue(
  $: EngineInterface,
  number: number,
  doing: string,
  flags: readonly string[],
): Promise<boolean> {
  const repo = await read($, repoA)
  if (!repo) return false
  const ok = await act($, doing, () => issueEdit($, repo.nameWithOwner, number, flags))
  if (ok) {
    void $.ui.toast(`#${number}: ${doing}`)
    await loadIssue($, number)
  }

  return ok
}

async function setField($: EngineInterface, d: IssueDetail, set: FieldSet): Promise<void> {
  const repo = await read($, repoA)
  if (!repo) return
  const ok = await act($, `setting ${set.field.name}`, () => issueSetFields($, d.id, [set]))
  if (!ok) return
  await update($, fieldTextA, old => {
    const { [set.field.id]: _, ...rest } = old
    return rest
  })
  void $.ui.toast(`#${d.number}: ${set.field.name} set`)
  await loadSide($, repo.nameWithOwner, d.number)
}

/** "#12", "12" or an issue URL, as gh takes it; empty when it is none of those. */
const issueArg = (text: string): string => {
  const t = text.trim().replace(/^#/, '')
  return /^\d+$/.test(t) || /^https:\/\/\S+\/issues\/\d+$/.test(t) ? t : ''
}

async function addRelation($: EngineInterface, number: number, text: string): Promise<void> {
  const kind = await read($, relationA)
  const rel = RELATIONS.find(r => r.kind === kind)
  const arg = issueArg(text)
  if (!rel) return
  if (!arg) {
    await update($, errorA, () => `${rel.label}: enter an issue number or URL`)
    return
  }
  const ok = await editIssue($, number, `${rel.label.toLowerCase()} #${arg} added`, [rel.add, arg])
  if (ok) await update($, relationInputA, () => '')
}

async function removeRelation($: EngineInterface, number: number, kind: RelationKind, other: IssueRef) {
  const rel = RELATIONS.find(r => r.kind === kind)
  if (!rel) return
  const flags = kind === 'parent' ? [rel.remove] : [rel.remove, String(other.number)]
  await editIssue($, number, `${rel.label.toLowerCase()} #${other.number} removed`, flags)
}

/** Creates an open milestone and reads the options again; resolves to its title, or '' on failure. */
async function addMilestone($: EngineInterface, text: string): Promise<string> {
  const repo = await read($, repoA)
  const title = text.trim()
  if (!repo || !title) return ''
  let made = ''
  const ok = await act($, `creating milestone ${title}`, async () => {
    made = await milestoneCreate($, repo.nameWithOwner, title)
  })
  if (!ok) return ''
  await update($, milestoneInputA, () => '')
  void $.ui.toast(`milestone ${made} created`)
  await loadOptions($, true)

  return made
}

async function develop($: EngineInterface, number: number): Promise<void> {
  const repo = await read($, repoA)
  if (!repo) return
  let out = ''
  const ok = await act($, `creating a branch for #${number}`, async () => {
    out = await issueDevelop($, repo.nameWithOwner, number)
  })
  if (!ok) return
  void $.ui.toast(`#${number}: branch created${out ? ` (${out.split('/').pop()})` : ''}`)
  await loadSide($, repo.nameWithOwner, number)
}

async function createIssue($: EngineInterface): Promise<void> {
  const repo = await ensureRepo($)
  const draft = await read($, draftA)
  if (!repo) return
  if (!draft.title.trim()) {
    await update($, errorA, () => 'new issue: title is empty')
    return
  }
  const { fields, branch, ...rest } = draft
  let number = 0
  const ok = await act($, 'creating issue', async () => {
    number = await issueCreate($, repo.nameWithOwner, {
      ...rest,
      title: draft.title.trim(),
      parent: issueArg(draft.parent),
    })
  })
  if (!ok) return
  await update($, draftA, () => EMPTY_DRAFT)
  void $.ui.toast(`#${number}: created`)

  // gh issue create takes no issue fields: they are set on the new issue afterwards.
  const defs = (await read($, optionsA))?.fields ?? []
  const sets: FieldSet[] = defs.flatMap(field => {
    const value = fields[field.id] ?? []
    if (value.length === 0 || value.every(v => !v.trim())) return []
    return [
      field.kind === 'single' || field.kind === 'multi'
        ? { field, optionIds: value }
        : { field, text: value[0] ?? '' },
    ]
  })
  if (sets.length > 0) {
    await act($, `setting fields of #${number}`, async () => {
      await issueSetFields($, await issueId($, repo.nameWithOwner, number), sets)
    })
  }
  if (branch) {
    await act($, `creating a branch for #${number}`, async () => {
      await issueDevelop($, repo.nameWithOwner, number)
    })
  }
  const error = await read($, errorA)
  await openIssue($, number)
  if (error) await update($, errorA, () => error)
  await loadList($)
}

/** What an issue's Claude dropdown submits a prompt for; Ask… only fills the prompt box. */
type ClaudeAction = 'discuss' | 'plan' | 'implement' | 'reply' | 'draft'

/** The Claude dropdown's options, in the order drawn. */
const CLAUDE_ACTIONS: { value: ClaudeAction | 'ask'; label: string }[] = [
  { value: 'discuss', label: 'Discuss' },
  { value: 'plan', label: 'Plan' },
  { value: 'implement', label: 'Implement' },
  { value: 'reply', label: 'Reply' },
  { value: 'draft', label: 'Reply (Draft)' },
  { value: 'ask', label: 'Ask…' },
]
/** The dropdown's resting option: picking it does nothing, so no action runs by accident. */
const CLAUDE_REST = { value: 'choose', label: 'Choose an action…' }

/** The tool through which Claude puts a draft comment into the pane's comment box. */
const DRAFT_TOOL = 'draft_comment'
const DRAFT_TOOL_FULL = 'mcp__gh-issues__draft_comment'

/** The prompt a Claude button submits: the issue, how to read it, then what to do and not to do. */
function claudePrompt(action: ClaudeAction, repo: string, d: IssueDetail, side: IssueSide | null): string {
  const branches = side?.number === d.number ? (side.extras?.branches ?? []) : []
  const blockers = d.blockedBy.filter(b => b.state === 'OPEN').map(b => `#${b.number}`)
  const issue = `GitHub issue #${d.number} of ${repo}: "${d.title}" (${d.url})`
  const readIt = `Read it with \`gh issue view ${d.number} --repo ${repo} --comments\`, and the code it concerns.`
  const blocked = blockers.length > 0 ? [`It is blocked by ${blockers.join(', ')}, still open.`] : []
  const hands = 'Do not edit files, create a branch or write to GitHub.'
  const comment =
    'Write a comment that answers the latest open question or request in the thread, or else says where the ' +
    'issue stands and proposes a way forward: Markdown, short and concrete, in the language of the thread.'

  const lines: Record<ClaudeAction, string[]> = {
    discuss: [
      `Discuss ${issue} with me.`,
      readIt,
      ...blocked,
      'Say in a few lines what it asks for and where it stands, list the open questions, and sketch two or ' +
        'three ways to resolve it with their trade-offs. Then ask me which way to go.',
      hands,
    ],
    plan: [
      `Plan the work on ${issue}.`,
      readIt,
      ...blocked,
      'Write a step-by-step plan: the files to change and how, the tests to add or run, risks and open questions.',
      `${hands} Wait for me to approve the plan.`,
    ],
    implement: [
      `Implement ${issue}.`,
      `Read it with \`gh issue view ${d.number} --repo ${repo} --comments\`.`,
      branches.length > 0
        ? `It has a linked branch on GitHub (${branches.join(', ')}): fetch and check that out instead of creating a new one.`
        : `Follow this repository's CLAUDE.md rules for branches and commits; where none exist, create a branch named issue-${d.number}-<short-slug> from the default branch.`,
      ...(blockers.length > 0
        ? [`It is blocked by ${blockers.join(', ')}, still open: say so before starting if that matters.`]
        : []),
      `Plan the change, implement it, run the relevant tests and commit, with "#${d.number}" in the commit message.`,
      'Do not push, open a pull request, comment on or close the issue unless asked.',
    ],
    reply: [
      `Reply to ${issue}.`,
      readIt,
      ...blocked,
      comment,
      `I pressed Reply in the GitHub issues pane, so post it without asking me again: ` +
        `\`gh issue comment ${d.number} --repo ${repo} --body-file -\` with the text on stdin. Then show me what you posted.`,
      'Do not edit files, or change, close or reopen the issue.',
    ],
    draft: [
      `Draft a reply to ${issue}.`,
      readIt,
      ...blocked,
      comment,
      `Put it in the comment box of the GitHub issues pane with the ${DRAFT_TOOL_FULL} tool, for me to edit and ` +
        'post. Do not post it yourself, edit files or change the issue.',
    ],
  }

  return lines[action].join('\n')
}

/** Runs what was picked in the Claude dropdown: a prompt for Claude, or the Ask… line in the prompt box. */
async function runClaude(
  $: EngineInterface,
  value: string,
  repo: string,
  d: IssueDetail,
  side: IssueSide | null,
): Promise<void> {
  const picked = CLAUDE_ACTIONS.find(a => a.value === value)
  if (!picked) return
  if (picked.value === 'ask') return askAbout($, repo, d)
  void $.prompt.submit({ text: claudePrompt(picked.value, repo, d, side) })
  void $.ui.toast(`#${d.number}: ${picked.label} handed to Claude`)
}

/** Ask…: puts a line naming the issue at the head of the prompt box, for the person to finish. */
async function askAbout($: EngineInterface, repo: string, d: IssueDetail): Promise<void> {
  const lead = `About GitHub issue #${d.number} of ${repo} ("${d.title}"): `
  const box = await $.prompt.read()
  const text = box.text.startsWith(lead) ? box.text : lead + box.text
  const { isFilled } = await $.prompt.fill({ text })
  void $.ui.toast(isFilled ? `#${d.number}: Esc to the prompt and type your question` : 'No prompt box to fill')
}

/** Serves the draft tool: opens the issue in the pane and puts the text into its comment box. */
async function placeDraft($: EngineInterface, number: number, body: string): Promise<string> {
  await openPane($, false)
  const shown = await read($, detailA)
  if ((await read($, viewA)) !== 'detail' || shown?.number !== number) await openIssue($, number)
  if ((await read($, detailA))?.number !== number) {
    return `#${number} could not be opened: ${(await read($, errorA)) || 'unknown error'}`
  }
  await update($, commentA, () => body)
  void $.ui.toast(`#${number}: Claude drafted a reply, review it in the comment box`)

  return ''
}

const ago = (iso: string): string => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ''
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`
  return iso.slice(0, 10)
}

const clip = (text: string, room: number): string =>
  room > 8 && text.length > room ? `${text.slice(0, room - 1)}…` : text

const milestoneText = (m: { title: string; dueOn: string }) =>
  m.dueOn ? `${m.title} · due ${m.dueOn.slice(0, 10)}` : m.title

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
    await $.tool.register({
      name: DRAFT_TOOL,
      description:
        'Puts a draft comment on a GitHub issue of the current repository into the comment box of the ' +
        'GitHub issues pane, opening that issue there, for the person to edit and post. Posts nothing. ' +
        'Use it when the person wants a reply drafted for review rather than posted.',
      inputSchema: {
        type: 'object',
        properties: {
          number: { type: 'integer', minimum: 1, description: 'The issue number.' },
          body: { type: 'string', description: 'The comment, in Markdown.' },
        },
        required: ['number', 'body'],
      },
    })

    return next(e)
  })

  on('tool.call', { tool: DRAFT_TOOL_FULL }, async ($, e) => {
    const number = Number(e.number)
    const body = typeof e.body === 'string' ? e.body : ''
    if (!Number.isInteger(number) || number < 1 || !body.trim()) {
      return { deny: `${DRAFT_TOOL} needs an issue number and a comment that is not empty` }
    }
    const failed = await placeDraft($, number, body)
    if (failed) return { deny: failed }

    return {
      result: `The draft is in the comment box of #${number} in the GitHub issues pane, not posted: the person edits and posts it from there.`,
    }
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
    const { Box, Text, Button, Link, Markdown, Select } = t
    const Input = 'Input' in t ? t.Input : undefined
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
    const note = (text: string) => pad(<Text color="subtle">{text}</Text>)
    // The terminal sizes an Input's text to the pane's full width minus its label and its Enter hint,
    // whatever Box holds it: padding around it pushes its line ends under the hint. So the Input
    // spans the pane and keeps its margins itself: its label starts with a space, and a one-line
    // field's hint ends with one. The rules above and below are inset by one column to match.
    const edge = pad(<Text color="promptBorder">{'─'.repeat(width)}</Text>)
    const field = (input: JSX.Element) => (
      <Box flexDirection="column" width={outer}>
        {edge}
        {input}
        {edge}
      </Box>
    )
    const inLabel = (text: string) => ` ${text}`
    // A field of several lines shows "· shift+⏎ new line" after its hint, so only one-line ones get the space.
    const oneLine = (submit: string) => `${submit} `
    // A toggle chip, as the label chips of the new issue form: a space either side so they sit flush.
    const chip = (key: string, picked: boolean, text: string, onPress: () => void) => (
      <Button key={key} plain onPress={onPress}>
        {picked ? (
          <Text color="suggestion" bold>{` ● ${text} `}</Text>
        ) : (
          <Text color="subtle">{` ○ ${text} `}</Text>
        )}
      </Button>
    )
    const chips = (nodes: JSX.Element[]) => (
      <Box flexDirection="row" flexWrap="wrap" width={outer}>
        {nodes}
      </Box>
    )
    const section = (caption: string, ...body: (JSX.Element | null | false)[]) => (
      <Box flexDirection="column" width={outer}>
        {pad(<Text bold>{caption}</Text>)}
        {body}
      </Box>
    )
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

    const sameRepo = (r: IssueRef) => !r.url || r.url.startsWith(`${repo.url}/issues/`)
    const dot = (state: string) => (
      <Text color={state === 'OPEN' ? 'success' : 'merged'}>●</Text>
    )
    /** A related issue: opened in the pane when it is in this repository, else a link. */
    const related = (key: string, r: IssueRef, room: number) =>
      sameRepo(r) ? (
        <Button key={key} plain onPress={() => void openIssue($, r.number)}>
          {dot(r.state)} <Text color="subtle">#{r.number}</Text>{' '}
          {clip(r.title, room - 4 - String(r.number).length)}
        </Button>
      ) : (
        <Link
          key={key}
          href={r.url}
          label={clip(`↗ ${r.url.replace(/^https:\/\/github\.com\//, '').replace('/issues/', '#')} ${r.title}`, room)}
        />
      )

    if (view === 'detail' || view === 'edit') {
      const d = await read($, detailA)
      const sideRaw = await read($, sideA)
      const side = d && sideRaw?.number === d.number ? sideRaw : null
      const comment = await read($, commentA)
      const editing = view === 'edit'
      const nav = (
        <Box flexDirection="row" gap={2}>
          <Button
            key="back"
            hotkey="b"
            plain
            onPress={() => void update($, viewA, () => (editing ? 'detail' : 'list'))}
          >
            <Text color="subtle">{editing ? '← Done' : '← Back'}</Text>
          </Button>
          {d && (
            <Button
              key="reload"
              hotkey="r"
              plain
              onPress={() => {
                void loadIssue($, d.number)
                if (editing) void loadOptions($, true)
              }}
            >
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

      if (editing) {
        const options = await read($, optionsA)
        const relation = await read($, relationA)
        const relationInput = await read($, relationInputA)
        const fieldText = await read($, fieldTextA)
        const milestoneInput = await read($, milestoneInputA)
        const values = side?.extras?.fields ?? []
        const onProjects = side?.projects?.map(p => p.title) ?? []
        const fieldEditor = (f: FieldDef) => {
          const current = values.find(v => v.fieldId === f.id)
          if (f.kind === 'single' || f.kind === 'multi') {
            const picked = current?.optionIds ?? []
            return (
              <Box key={`fieldbox-${f.id}`} flexDirection="column" width={outer}>
                {note(f.kind === 'multi' ? `${f.name} · pick any` : f.name)}
                {chips(
                  f.options.map(o =>
                    chip(`field-${f.id}-${o.id}`, picked.includes(o.id), o.name, () => {
                      const next =
                        f.kind === 'single'
                          ? picked.includes(o.id) ? [] : [o.id]
                          : picked.includes(o.id)
                            ? picked.filter(p => p !== o.id)
                            : [...picked, o.id]
                      void setField($, d, { field: f, optionIds: next })
                    }),
                  ),
                )}
              </Box>
            )
          }
          if (!Input) return note(`${f.name}: ${current?.value || '–'}`)
          const hint = f.kind === 'date' ? 'YYYY-MM-DD' : f.kind === 'number' ? 'a number' : 'text'
          return (
            <Box key={`fieldbox-${f.id}`} flexDirection="column" width={outer}>
              {field(
                <Input
                  key={`field-${f.id}`}
                  label={inLabel(f.name)}
                  placeholder={`${hint} · empty clears it`}
                  submitLabel={oneLine('set')}
                  value={fieldText[f.id] ?? current?.value ?? ''}
                  onInput={value => void update($, fieldTextA, old => ({ ...old, [f.id]: value }))}
                  onSubmit={value => void setField($, d, { field: f, text: value })}
                />,
              )}
            </Box>
          )
        }
        const relRows: { kind: RelationKind; label: string; r: IssueRef }[] = [
          ...(d.parent ? [{ kind: 'parent' as const, label: 'Parent', r: d.parent }] : []),
          ...d.subIssues.map(r => ({ kind: 'sub' as const, label: 'Sub-issue', r })),
          ...d.blockedBy.map(r => ({ kind: 'blockedBy' as const, label: 'Blocked by', r })),
          ...d.blocking.map(r => ({ kind: 'blocking' as const, label: 'Blocking', r })),
        ]
        const extras = side?.extras
        // The type set on the issue stays pickable even if the organization has since disabled it.
        const types = [
          ...(options?.types ?? []),
          ...(options?.types && d.type && !options.types.includes(d.type) ? [d.type] : []),
        ]
        const fieldDefs = options?.fields ?? []

        return (
          <Box flexDirection="column" gap={1} width={outer}>
            <Box flexDirection="column" gap={1} paddingX={1}>
              {header(`#${d.number} · details`)}
              {nav}
              <Text bold>{clip(d.title, width)}</Text>
              {status}
            </Box>
            {!options && !busy && note('Loading what this repository offers…')}

            {/* Types and fields exist only where an organization set them up: elsewhere, no section. */}
            {types.length > 0 &&
              section(
                'Type',
                chips(
                  types.map(type =>
                    chip(`type-${type}`, d.type === type, type, () =>
                      void editIssue(
                        $,
                        d.number,
                        d.type === type ? 'type removed' : `type set to ${type}`,
                        d.type === type ? ['--remove-type'] : ['--type', type],
                      ),
                    ),
                  ),
                ),
              )}

            {fieldDefs.length > 0 &&
              section(
                'Fields',
                ...(side && !side.extras
                  ? [note(`Fields could not be read: ${side.extrasNote}`)]
                  : fieldDefs.map(fieldEditor)),
              )}

            {section(
              'Projects',
              options?.projects === null || (side && side.projects === null)
                ? note(options?.projectsNote || side?.projectsNote || 'Projects could not be read.')
                : options?.projects?.length === 0
                  ? note('The repository owner has no open projects.')
                  : chips(
                      (options?.projects ?? []).map(title =>
                        chip(`project-${title}`, onProjects.includes(title), title, () =>
                          void editIssue(
                            $,
                            d.number,
                            onProjects.includes(title) ? `removed from ${title}` : `added to ${title}`,
                            [onProjects.includes(title) ? '--remove-project' : '--add-project', title],
                          ),
                        ),
                      ),
                    ),
            )}

            {section(
              'Milestone',
              options?.milestones.length === 0 && !d.milestone
                ? note('No open milestones yet.')
                : chips(
                    [
                      ...(options?.milestones ?? []),
                      ...(d.milestone && !options?.milestones.some(m => m.title === d.milestone?.title)
                        ? [d.milestone]
                        : []),
                    ].map(m => {
                      const isSet = d.milestone?.title === m.title
                      return chip(`milestone-${m.title}`, isSet, milestoneText(m), () =>
                        void editIssue(
                          $,
                          d.number,
                          isSet ? 'milestone removed' : `milestone set to ${m.title}`,
                          isSet ? ['--remove-milestone'] : ['--milestone', m.title],
                        ),
                      )
                    }),
                  ),
              Input
                ? field(
                    <Input
                      key="milestone-new"
                      label={inLabel('New milestone')}
                      placeholder="title"
                      submitLabel={oneLine('create')}
                      value={milestoneInput}
                      onInput={value => void update($, milestoneInputA, () => value)}
                      onSubmit={async value => {
                        const title = await addMilestone($, value)
                        if (title) {
                          await editIssue($, d.number, `milestone set to ${title}`, ['--milestone', title])
                        }
                      }}
                    />,
                  )
                : null,
            )}

            {section(
              'Relationships',
              <Box flexDirection="column" paddingLeft={1}>
                {relRows.length === 0 && <Text color="subtle">None yet.</Text>}
                {relRows.map(({ kind, label, r }) => (
                  <Box key={`relrow-${kind}-${r.number}`} flexDirection="row">
                    <Box width={12}>
                      <Text color="subtle">{label}</Text>
                    </Box>
                    <Button key={`unrel-${kind}-${r.number}`} plain onPress={() => void removeRelation($, d.number, kind, r)}>
                      <Text color="error">{' ✕ '}</Text>
                    </Button>
                    {related(`rel-${kind}-${r.number}`, r, width - 16)}
                  </Box>
                ))}
              </Box>,
              chips(
                RELATIONS.map(rel =>
                  chip(`relkind-${rel.kind}`, relation === rel.kind, rel.label, () =>
                    void update($, relationA, () => rel.kind),
                  ),
                ),
              ),
              Input
                ? field(
                    <Input
                      key="relation"
                      label={inLabel('Add')}
                      placeholder={`${RELATIONS.find(r => r.kind === relation)?.label.toLowerCase()}: issue number or URL`}
                      submitLabel={oneLine('add')}
                      value={relationInput}
                      onInput={value => void update($, relationInputA, () => value)}
                      onSubmit={value => void addRelation($, d.number, value)}
                    />,
                  )
                : null,
            )}

            {section(
              'Development',
              <Box flexDirection="column" paddingLeft={1}>
                {side && !extras && <Text color="subtle">Could not be read: {side.extrasNote}</Text>}
                {extras?.branches.map(b => (
                  <Text key={`branch-${b}`}>
                    <Text color="subtle">⎇</Text> {b}
                  </Text>
                ))}
                {extras?.pulls.map(p => (
                  <Link key={`pr-${p.number}`} href={p.url} label={clip(`↗ #${p.number} ${p.title}`, width)} />
                ))}
                {extras && extras.branches.length === 0 && extras.pulls.length === 0 && (
                  <Text color="subtle">No linked branches or pull requests.</Text>
                )}
              </Box>,
              <Box flexDirection="row" paddingLeft={1}>
                <Button key="develop" onPress={() => void develop($, d.number)}>
                  Create a linked branch
                </Button>
              </Box>,
              note('Created on GitHub, not checked out: git fetch, then git switch <branch>.'),
            )}
          </Box>
        )
      }

      const isOpen = d.state === 'OPEN'
      const notPlanned = d.stateReason === 'NOT_PLANNED'
      const stateText = isOpen ? 'Open' : notPlanned ? 'Closed · not planned' : 'Closed'
      const stateColor = isOpen ? 'success' : notPlanned ? 'subtle' : 'merged'
      const nComments = `${d.comments.length} ${d.comments.length === 1 ? 'comment' : 'comments'}`

      // The sidebar of an issue on GitHub, as rows: a caption, then what is set. Empty rows are left out.
      const LABEL = 12
      const room = width - LABEL
      const metaRow = (key: string, label: string, ...content: (JSX.Element | null | false)[]) => (
        <Box key={key} flexDirection="row" width={width}>
          <Box width={LABEL} flexShrink={0}>
            <Text color="subtle">{label}</Text>
          </Box>
          <Box flexDirection="column" flexShrink={1}>
            {content}
          </Box>
        </Box>
      )
      const fields = side?.extras?.fields.filter(f => f.value) ?? []
      const projects = side?.projects ?? []
      const branches = side?.extras?.branches ?? []
      const pulls = side?.extras?.pulls ?? []
      const meta = [
        d.type && metaRow('meta-type', 'Type', <Text>{d.type}</Text>),
        fields.length > 0 &&
          metaRow(
            'meta-fields',
            'Fields',
            ...fields.map(f => (
              <Text key={`fv-${f.fieldId}`}>
                <Text color="subtle">{f.name}</Text> {f.value}
              </Text>
            )),
          ),
        projects.length > 0 &&
          metaRow(
            'meta-projects',
            'Projects',
            ...projects.map(p => (
              <Text key={`pj-${p.title}`}>
                {p.title}
                {p.status && <Text color="subtle"> · {p.status}</Text>}
              </Text>
            )),
          ),
        d.milestone && metaRow('meta-milestone', 'Milestone', <Text>{milestoneText(d.milestone)}</Text>),
        d.parent && metaRow('meta-parent', 'Parent', related(`rel-parent-${d.parent.number}`, d.parent, room)),
        d.subIssues.length > 0 &&
          metaRow(
            'meta-sub',
            'Sub-issues',
            <Text color="subtle">{`${d.subIssuesDone} of ${d.subIssues.length} done`}</Text>,
            ...d.subIssues.map(r => related(`rel-sub-${r.number}`, r, room)),
          ),
        d.blockedBy.length > 0 &&
          metaRow('meta-blocked-by', 'Blocked by', ...d.blockedBy.map(r => related(`rel-blockedBy-${r.number}`, r, room))),
        d.blocking.length > 0 &&
          metaRow('meta-blocking', 'Blocking', ...d.blocking.map(r => related(`rel-blocking-${r.number}`, r, room))),
        (branches.length > 0 || pulls.length > 0) &&
          metaRow(
            'meta-dev',
            'Development',
            ...branches.map(b => (
              <Text key={`br-${b}`}>
                <Text color="subtle">⎇</Text> {clip(b, room - 2)}
              </Text>
            )),
            ...pulls.map(p => (
              <Link
                key={`pr-${p.number}`}
                href={p.url}
                label={clip(`↗ #${p.number} ${p.title} (${p.isDraft ? 'draft' : p.state.toLowerCase()})`, room)}
              />
            )),
          ),
      ].filter((row): row is JSX.Element => Boolean(row))
      // A row of buttons under a caption in the meta rows' column, wrapping beside it, not under it.
      const actionRow = (caption: string, ...buttons: JSX.Element[]) => (
        <Box flexDirection="row" width={width}>
          <Box width={LABEL} flexShrink={0}>
            <Text color="subtle">{caption}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap" flexShrink={1}>
            {buttons}
          </Box>
        </Box>
      )

      return (
        <Box flexDirection="column" gap={1} width={outer}>
          <Box flexDirection="column" gap={1} paddingX={1}>
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
            {meta.length > 0 && <Box flexDirection="column">{meta}</Box>}
            <Box flexDirection="column" gap={1}>
              {actionRow(
                'Claude',
                <Select
                  key="claude"
                  options={[CLAUDE_REST, ...CLAUDE_ACTIONS]}
                  value={CLAUDE_REST.value}
                  onSelect={value => void runClaude($, value, repo.nameWithOwner, d, side)}
                />,
              )}
              {actionRow(
                'Issue',
                <Button key="edit" hotkey="e" onPress={() => void openEdit($)}>
                  Edit details
                </Button>,
                ...(isOpen
                  ? [
                      <Button key="close" hotkey="c" onPress={() => void setState($, d.number, 'completed')}>
                        Close as completed
                      </Button>,
                      <Button key="close-np" onPress={() => void setState($, d.number, 'not planned')}>
                        Close as not planned
                      </Button>,
                    ]
                  : [
                      <Button key="reopen" hotkey="o" onPress={() => void setState($, d.number, 'reopen')}>
                        Reopen
                      </Button>,
                    ]),
                <Link key="github" href={d.url} label="↗ GitHub" />,
              )}
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
          </Box>
          {Input &&
            field(
              <Input
                key="comment"
                label={inLabel('Comment')}
                placeholder="Markdown"
                rows={3}
                submitLabel="post"
                value={comment}
                onInput={value => void update($, commentA, () => value)}
                onSubmit={value => void submitComment($, d.number, value)}
              />,
            )}
        </Box>
      )
    }

    if (view === 'new') {
      const draft = await read($, draftA)
      const labels = await read($, labelsA)
      const options = await read($, optionsA)
      const relation = await read($, relationA)
      const relationInput = await read($, relationInputA)
      const milestoneInput = await read($, milestoneInputA)
      const patch =(p: Partial<IssueDraft>) => void update($, draftA, old => ({ ...old, ...p }))
      const toggle = (list: readonly string[], item: string) =>
        list.includes(item) ? list.filter(x => x !== item) : [...list, item]
      const toggleLabel = (label: string) =>
        void update($, draftA, old => ({ ...old, labels: toggle(old.labels, label) }))
      const setFieldDraft = (id: string, value: string[]) =>
        void update($, draftA, old => ({ ...old, fields: { ...old.fields, [id]: value } }))
      // A new issue can have a parent and blockers, not sub-issues: gh issue create has no flag for those.
      const NEW_RELATIONS = RELATIONS.filter(r => r.kind !== 'sub')
      const newRelation = NEW_RELATIONS.some(r => r.kind === relation) ? relation : 'blockedBy'
      const addDraftRelation = (text: string) => {
        const arg = issueArg(text)
        if (!arg) {
          void update($, errorA, () => 'enter an issue number or URL')
          return
        }
        void update($, draftA, old =>
          newRelation === 'parent'
            ? { ...old, parent: arg }
            : newRelation === 'blocking'
              ? { ...old, blocking: old.blocking.includes(arg) ? old.blocking : [...old.blocking, arg] }
              : { ...old, blockedBy: old.blockedBy.includes(arg) ? old.blockedBy : [...old.blockedBy, arg] },
        )
        void update($, relationInputA, () => '')
        void update($, errorA, () => '')
      }
      const draftRelations: { kind: RelationKind; label: string; arg: string }[] = [
        ...(draft.parent ? [{ kind: 'parent' as const, label: 'parent', arg: draft.parent }] : []),
        ...draft.blockedBy.map(arg => ({ kind: 'blockedBy' as const, label: 'blocked by', arg })),
        ...draft.blocking.map(arg => ({ kind: 'blocking' as const, label: 'blocking', arg })),
      ]
      const dropDraftRelation = (kind: RelationKind, arg: string) =>
        void update($, draftA, old =>
          kind === 'parent'
            ? { ...old, parent: '' }
            : kind === 'blocking'
              ? { ...old, blocking: old.blocking.filter(x => x !== arg) }
              : { ...old, blockedBy: old.blockedBy.filter(x => x !== arg) },
        )
      const types = options?.types ?? []
      const fieldDefs = options?.fields ?? []
      const milestones = options?.milestones ?? []
      const projects = options?.projects ?? []
      const short = (s: string) => (/^\d+$/.test(s) ? `#${s}` : s.replace(/^https:\/\/github\.com\//, ''))

      return (
        <Box flexDirection="column" gap={1} width={outer}>
          {pad(header('new issue'))}
          {Input ? (
            <>
              {field(
                <Input
                  key="new-title"
                  autoFocus
                  label={inLabel('Title')}
                  placeholder="Short summary"
                  value={draft.title}
                  submitLabel={oneLine('next')}
                  onInput={value => patch({ title: value })}
                  onSubmit={value => patch({ title: value })}
                />,
              )}
              {field(
                <Input
                  key="new-body"
                  label={inLabel('Description')}
                  placeholder="Markdown"
                  rows={8}
                  value={draft.body}
                  submitLabel="create"
                  onInput={value => patch({ body: value })}
                  onSubmit={value => {
                    patch({ body: value })
                    void createIssue($)
                  }}
                />,
              )}
            </>
          ) : (
            pad(
              <Text color="subtle">
                This surface has no text fields; create issues from the terminal or desktop app.
              </Text>,
            )
          )}
          {labels.length > 0 && (
            <Box flexDirection="column">
              {pad(<Text color="subtle">Labels</Text>)}
              {/* Chips carry a space either side, as the filter tabs do, so they sit flush. */}
              {chips(labels.map(label => chip(`label-${label}`, draft.labels.includes(label), label, () => toggleLabel(label))))}
            </Box>
          )}
          {types.length > 0 && (
            <Box flexDirection="column">
              {pad(<Text color="subtle">Type</Text>)}
              {chips(
                types.map(type =>
                  chip(`new-type-${type}`, draft.type === type, type, () =>
                    patch({ type: draft.type === type ? '' : type }),
                  ),
                ),
              )}
            </Box>
          )}
          {fieldDefs.map(f => {
            const value = draft.fields[f.id] ?? []
            if (f.kind === 'single' || f.kind === 'multi') {
              return (
                <Box key={`new-fieldbox-${f.id}`} flexDirection="column">
                  {pad(<Text color="subtle">{f.name}</Text>)}
                  {chips(
                    f.options.map(o =>
                      chip(`new-field-${f.id}-${o.id}`, value.includes(o.id), o.name, () =>
                        setFieldDraft(
                          f.id,
                          f.kind === 'single' ? (value.includes(o.id) ? [] : [o.id]) : toggle(value, o.id),
                        ),
                      ),
                    ),
                  )}
                </Box>
              )
            }
            if (!Input) return null
            return (
              <Box key={`new-fieldbox-${f.id}`} flexDirection="column">
                {field(
                  <Input
                    key={`new-field-${f.id}`}
                    label={inLabel(f.name)}
                    placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : f.kind === 'number' ? 'a number' : 'text'}
                    submitLabel={oneLine('next')}
                    value={value[0] ?? ''}
                    onInput={text => setFieldDraft(f.id, [text])}
                    onSubmit={text => setFieldDraft(f.id, [text])}
                  />,
                )}
              </Box>
            )
          })}
          {projects.length > 0 ? (
            <Box flexDirection="column">
              {pad(<Text color="subtle">Projects</Text>)}
              {chips(
                projects.map(title =>
                  chip(`new-project-${title}`, draft.projects.includes(title), title, () =>
                    patch({ projects: toggle(draft.projects, title) }),
                  ),
                ),
              )}
            </Box>
          ) : (
            options?.projectsNote && note(options.projectsNote)
          )}
          {options && (
            <Box flexDirection="column">
              {pad(<Text color="subtle">Milestone</Text>)}
              {milestones.length > 0
                ? chips(
                    milestones.map(m =>
                      chip(`new-milestone-${m.title}`, draft.milestone === m.title, milestoneText(m), () =>
                        patch({ milestone: draft.milestone === m.title ? '' : m.title }),
                      ),
                    ),
                  )
                : note('No open milestones yet.')}
              {Input &&
                field(
                  <Input
                    key="new-milestone"
                    label={inLabel('New milestone')}
                    placeholder="title"
                    submitLabel={oneLine('create')}
                    value={milestoneInput}
                    onInput={value => void update($, milestoneInputA, () => value)}
                    onSubmit={async value => {
                      const title = await addMilestone($, value)
                      if (title) patch({ milestone: title })
                    }}
                  />,
                )}
            </Box>
          )}
          {Input && (
            <Box flexDirection="column">
              {pad(<Text color="subtle">Relationships</Text>)}
              {draftRelations.length > 0 &&
                chips(
                  draftRelations.map(r => (
                    <Button key={`new-unrel-${r.kind}-${r.arg}`} plain onPress={() => dropDraftRelation(r.kind, r.arg)}>
                      <Text color="suggestion">{` ${r.label} ${short(r.arg)} `}</Text>
                      <Text color="error">{'✕ '}</Text>
                    </Button>
                  )),
                )}
              {chips(
                NEW_RELATIONS.map(rel =>
                  chip(`new-relkind-${rel.kind}`, newRelation === rel.kind, rel.label, () =>
                    void update($, relationA, () => rel.kind),
                  ),
                ),
              )}
              {field(
                <Input
                  key="new-relation"
                  label={inLabel('Add')}
                  placeholder={`${NEW_RELATIONS.find(r => r.kind === newRelation)?.label.toLowerCase()}: issue number or URL`}
                  submitLabel={oneLine('add')}
                  value={relationInput}
                  onInput={value => void update($, relationInputA, () => value)}
                  onSubmit={addDraftRelation}
                />,
              )}
            </Box>
          )}
          <Box flexDirection="column">
            {pad(<Text color="subtle">Development</Text>)}
            {chips([
              chip('new-branch', draft.branch, 'Create a linked branch', () => patch({ branch: !draft.branch })),
            ])}
            {draft.branch && note('Made on GitHub once the issue exists; not checked out.')}
          </Box>
          <Box flexDirection="row" gap={1} paddingLeft={1}>
            <Button key="create" variant="primary" onPress={() => void createIssue($)}>
              Create issue
            </Button>
            <Button key="cancel" onPress={() => void update($, viewA, () => 'list')}>
              Cancel
            </Button>
          </Box>
          {pad(status)}
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
            const title = clip(issue.title, room)

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
