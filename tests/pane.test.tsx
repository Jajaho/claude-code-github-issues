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
}

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
function fakeGh(on: On, calls: Call[], onSubmit: (text: string) => void = () => {}) {
  on('process.run', (_, e) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    const [, group, verb] = e.argv
    const out = (stdout: unknown) => ({
      value: {
        exitCode: 0,
        stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    })
    if (group === 'repo') return out(REPO)
    if (group === 'label') return out([{ name: 'bug' }, { name: 'enhancement' }])
    if (verb === 'list') return out(ROWS)
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
  expect((await ui.find({ type: 'Text', text: /acme\/widgets/ }))?.text).toBe('acme/widgets')
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

test('a new issue is created with title, body and label', async ($, on) => {
  const calls: Call[] = []
  fakeGh(on, calls)
  await runIssues($, 'new')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'new-title', text: 'Add dark mode', kind: 'change' })
  await ui.select({ key: 'new-label', value: 'enhancement' })
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
