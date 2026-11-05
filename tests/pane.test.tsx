import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'gh-issues',
  component: 'Pane',
  requestId: 'gh-issues',
  props: {
    title: 'GitHub issues',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const REPO = { nameWithOwner: 'acme/widgets', url: 'https://github.com/acme/widgets' }
const ROWS = [
  {
    number: 7,
    title: 'Crash on empty config',
    state: 'OPEN',
    labels: [{ name: 'bug' }],
    assignees: [],
    author: { login: 'alice' },
    updatedAt: '2026-11-01T10:00:00Z',
  },
]
const DETAIL = {
  ...ROWS[0],
  body: 'Steps to reproduce: start with an empty file.',
  stateReason: '',
  createdAt: '2026-10-30T10:00:00Z',
  url: 'https://github.com/acme/widgets/issues/7',
  comments: [{ author: { login: 'bob' }, body: 'Seen here too.', createdAt: '2026-10-31T10:00:00Z' }],
  id: 'I_7',
  issueType: { name: 'Bug' },
  milestone: { title: 'v1.0', dueOn: '2026-12-01T00:00:00Z' },
  parent: { number: 2, title: 'Config overhaul', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/2' },
  subIssues: { nodes: [], totalCount: 0 },
  subIssuesSummary: { completed: 0, total: 0 },
  blockedBy: {
    nodes: [{ number: 3, title: 'Schema first', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/3' }],
  },
  blocking: { nodes: [] },
}
const PRIORITY = {
  __typename: 'IssueFieldSingleSelect',
  id: 'F_prio',
  name: 'Priority',
  options: [{ id: 'O_p1', name: 'P1' }, { id: 'O_p2', name: 'P2' }],
}
const EFFORT = { __typename: 'IssueFieldNumber', id: 'F_effort', name: 'Effort' }
const EXTRAS = {
  repository: {
    issue: {
      issueFieldValues: {
        nodes: [{ name: 'P2', optionId: 'O_p2', field: { id: 'F_prio', name: 'Priority' } }],
      },
      linkedBranches: { nodes: [{ ref: { name: '7-crash-on-empty-config' } }] },
      closedByPullRequestsReferences: {
        nodes: [
          { number: 9, title: 'Guard empty config', state: 'OPEN', isDraft: false, url: 'https://github.com/acme/widgets/pull/9' },
        ],
      },
    },
  },
}
const OPTIONS = {
  repository: {
    issueTypes: { nodes: [{ name: 'Bug', isEnabled: true }, { name: 'Feature', isEnabled: true }] },
    issueFields: { nodes: [PRIORITY, EFFORT] },
    milestones: { nodes: [{ title: 'v1.0', dueOn: '2026-12-01T00:00:00Z' }, { title: 'v2.0', dueOn: null }] },
  },
}
const PERSONAL_OPTIONS = { repository: { issueTypes: null, issueFields: null, milestones: { nodes: [] } } }
const NO_SCOPE = 'error: your authentication token is missing required scopes [read:project]\n'

const run = (args: string) => ({
  command: 'issues',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const)
const runIssues = ($: { command: { run: (i: ReturnType<typeof run>) => Promise<unknown> } }, args: string) =>
  $.command.run(run(args))

type Call = { argv: readonly string[]; stdin?: string }

/** Stands in for gh: answers by subcommand and records every call. */
function fakeGh(
  on: On,
  calls: Call[],
  onSubmit: (text: string) => void = () => {},
  { projectScope = true, personal = false } = {},
) {
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const [, group, verb] = e.argv
    const out = (stdout: unknown, exitCode = 0, stderr = '') => ({
      value: {
        exitCode,
        stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
        stderr,
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    })
    const wantsProjects = group === 'project' || e.argv.includes('projectItems')
    if (wantsProjects && !projectScope) return out('', 1, NO_SCOPE)
    if (group === 'repo') return out(REPO)
    if (group === 'label') return out([{ name: 'bug' }, { name: 'enhancement' }])
    if (group === 'project') return out({ projects: [{ title: 'Roadmap', closed: false }], totalCount: 1 })
    if (group === 'api' && verb?.endsWith('/milestones')) return out({ title: (e.argv.find(a => a.startsWith('title=')) ?? '').slice(6) })
    if (group === 'api') {
      const query = String(JSON.parse(e.init?.stdin ?? '{}').query ?? '')
      if (query.includes('setIssueFieldValue')) return out({ data: { setIssueFieldValue: { clientMutationId: null } } })
      return out({ data: query.includes('issueTypes') ? (personal ? PERSONAL_OPTIONS : OPTIONS) : EXTRAS })
    }
    if (verb === 'list') return out(ROWS)
    if (verb === 'view' && e.argv.includes('projectItems')) {
      return out({ projectItems: [{ title: 'Roadmap', status: { optionId: 's1', name: 'In progress' } }] })
    }
    if (verb === 'view' && e.argv[e.argv.length - 1] === 'id') return out({ id: 'I_8' })
    if (verb === 'view') return out(DETAIL)
    if (verb === 'create') return out('https://github.com/acme/widgets/issues/8\n')

    return out('')
  })
  on('command.register', () => ({ value: { command: 'issues' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    onSubmit(e.text)
    return { text: e.text }
  })
}

test('the list shows issues and opens one with its comments', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, '')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /acme\/widgets/ }))?.text).toBe('● acme/widgets')
  expect(await ui.find({ key: 'issue-7' })).toBeDefined()

  await ui.press({ key: 'issue-7' })
  expect(await ui.find({ type: 'Text', text: /Crash on empty config/ })).toBeDefined()
  expect(calls.some(c => c.argv.join(' ').startsWith('gh issue view 7'))).toBe(true)
  await ui.unmount()
})

test('a comment is posted through stdin and close passes the reason', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, '7')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'comment', text: 'Fixed in main.' })
  const posted = calls.find(c => c.argv[2] === 'comment')
  expect(posted?.argv).toEqual(['gh', 'issue', 'comment', '7', '--repo', 'acme/widgets', '--body-file', '-'])
  expect(posted?.stdin).toBe('Fixed in main.')

  await ui.press({ key: 'close-np' })
  const closed = calls.find(c => c.argv[2] === 'close')
  expect(closed?.argv).toEqual(['gh', 'issue', 'close', '7', '--repo', 'acme/widgets', '--reason', 'not planned'])
  await ui.unmount()
})

test('a new issue is created with title, body and the labels clicked', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, 'new')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'new-title', text: 'Add dark mode', kind: 'change' })
  await ui.press({ key: 'label-bug' })
  await ui.press({ key: 'label-enhancement' })
  await ui.press({ key: 'label-bug' })
  await ui.input({ key: 'new-body', text: 'Details.', kind: 'change' })
  await ui.press({ key: 'create' })

  const created = calls.find(c => c.argv[2] === 'create')
  expect(created?.argv).toEqual([
    'gh', 'issue', 'create', '--repo', 'acme/widgets', '--title', 'Add dark mode',
    '--body-file', '-', '--label', 'enhancement',
  ])
  expect(created?.stdin).toBe('Details.')
  expect(calls.some(c => c.argv.join(' ').startsWith('gh issue view 8'))).toBe(true)
  await ui.unmount()
})

test('two clicked labels are both passed to gh', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, 'new')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'new-title', text: 'Flaky start-up', kind: 'change' })
  await ui.press({ key: 'label-bug' })
  await ui.press({ key: 'label-enhancement' })
  await ui.press({ key: 'create' })

  const created = calls.find(c => c.argv[2] === 'create')
  expect(created?.argv.slice(-4)).toEqual(['--label', 'bug', '--label', 'enhancement'])
  await ui.unmount()
})

test('work on this issue submits a prompt naming the issue', async ($, on) => {
  const calls: Call[] = []
  let submitted = ''
  fakeGh(on, calls, text => {
    submitted = text
  })
  await runIssues($, '#7')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'work' })
  expect(submitted).toContain('GitHub issue #7 of acme/widgets')
  expect(submitted).toContain('Do not push')
  await ui.unmount()
})

test('the detail view shows type, fields, projects, milestone, relationships and development', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, '7')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const text of [/^Bug$/, /Priority P2/, /Roadmap · In progress/, /v1\.0 · due 2026-12-01/, /7-crash-on-empty-config/]) {
    expect((await ui.find({ type: 'Text', text }))?.text).toMatch(text)
  }
  expect(await ui.find({ type: 'Link', text: /#9 Guard empty config \(open\)/ })).toBeDefined()
  expect(await ui.find({ key: 'rel-parent-2' })).toBeDefined()
  await ui.press({ key: 'rel-blockedBy-3' })
  expect(calls.some(c => c.argv.join(' ').startsWith('gh issue view 3'))).toBe(true)
  await ui.unmount()
})

test('a token without the project scope hides projects, not the issue', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls, undefined, { projectScope: false })
  await runIssues($, '7')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Crash on empty config/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Bug$/ })).toBeDefined()
  await ui.press({ key: 'edit' })
  expect(await ui.find({ type: 'Text', text: /gh auth refresh -s project/ })).toBeDefined()
  expect(await ui.find({ key: 'type-Feature' })).toBeDefined()
  await ui.unmount()
})

test('the edit view sets type, milestone, projects, fields and relationships through gh', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, '7')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit' })
  const edits = () => calls.filter(c => c.argv[2] === 'edit').map(c => c.argv.slice(3))

  await ui.press({ key: 'type-Feature' })
  await ui.press({ key: 'type-Bug' })
  await ui.press({ key: 'milestone-v1.0' })
  await ui.press({ key: 'milestone-v2.0' })
  await ui.press({ key: 'project-Roadmap' })
  await ui.press({ key: 'unrel-parent-2' })
  await ui.press({ key: 'relkind-sub' })
  await ui.input({ key: 'relation', text: '#12' })
  const R = ['--repo', 'acme/widgets']
  expect(edits()).toEqual([
    ['7', ...R, '--type', 'Feature'],
    ['7', ...R, '--remove-type'],
    ['7', ...R, '--remove-milestone'],
    ['7', ...R, '--milestone', 'v2.0'],
    ['7', ...R, '--remove-project', 'Roadmap'],
    ['7', ...R, '--remove-parent'],
    ['7', ...R, '--add-sub-issue', '12'],
  ])

  await ui.press({ key: 'field-F_prio-O_p1' })
  await ui.input({ key: 'field-F_effort', text: '3' })
  const sets = calls
    .filter(c => c.argv[1] === 'api' && c.stdin?.includes('setIssueFieldValue'))
    .map(c => JSON.parse(c.stdin ?? '{}').variables.input)
  expect(sets).toEqual([
    { issueId: 'I_7', issueFields: [{ fieldId: 'F_prio', singleSelectOptionId: 'O_p1' }] },
    { issueId: 'I_7', issueFields: [{ fieldId: 'F_effort', numberValue: 3 }] },
  ])

  await ui.press({ key: 'develop' })
  expect(calls.some(c => c.argv.join(' ') === 'gh issue develop 7 --repo acme/widgets')).toBe(true)
  await ui.unmount()
})

test('a new issue carries type, milestone, project, parent and blocker, then its fields', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, 'new')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'new-title', text: 'Dark mode', kind: 'change' })
  await ui.press({ key: 'new-type-Feature' })
  await ui.press({ key: 'new-milestone-v2.0' })
  await ui.press({ key: 'new-project-Roadmap' })
  await ui.press({ key: 'new-field-F_prio-O_p1' })
  await ui.press({ key: 'new-relkind-parent' })
  await ui.input({ key: 'new-relation', text: '#2' })
  await ui.press({ key: 'new-relkind-blockedBy' })
  await ui.input({ key: 'new-relation', text: '3' })
  await ui.press({ key: 'create' })

  const created = calls.find(c => c.argv[2] === 'create')
  expect(created?.argv.slice(9)).toEqual([
    '--type', 'Feature', '--milestone', 'v2.0', '--project', 'Roadmap', '--parent', '2', '--blocked-by', '3',
  ])
  const set = calls.find(c => c.stdin?.includes('setIssueFieldValue'))
  expect(JSON.parse(set?.stdin ?? '{}').variables.input).toEqual({
    issueId: 'I_8',
    issueFields: [{ fieldId: 'F_prio', singleSelectOptionId: 'O_p1' }],
  })
  await ui.unmount()
})

test('a personal repository shows no type or fields sections', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls, undefined, { personal: true })
  await runIssues($, '7')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'edit' })
  expect(await ui.find({ type: 'Text', text: /^Type$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Fields$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /issue (types|fields)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Milestone$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Development$/ })).toBeDefined()
  await ui.unmount()
})

test('a new issue in a repository without milestones creates one, and a linked branch', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls, undefined, { personal: true })
  await runIssues($, 'new')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'new-type-Bug' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No open milestones yet/ })).toBeDefined()
  await ui.input({ key: 'new-title', text: 'Dark mode', kind: 'change' })
  await ui.input({ key: 'new-milestone', text: 'v1.0' })
  const made = calls.find(c => c.argv[2]?.endsWith('/milestones'))
  expect(made?.argv).toEqual(['gh', 'api', 'repos/acme/widgets/milestones', '--method', 'POST', '-f', 'title=v1.0'])
  await ui.press({ key: 'new-branch' })
  await ui.press({ key: 'create' })

  const created = calls.find(c => c.argv[2] === 'create')
  expect(created?.argv.slice(9)).toEqual(['--milestone', 'v1.0'])
  expect(calls.some(c => c.argv.join(' ') === 'gh issue develop 8 --repo acme/widgets')).toBe(true)
  await ui.unmount()
})
