import type { EngineInterface } from 'claude-code'

import type { IssueComment, IssueDetail, IssueRow, RepoInfo } from '../types'

type Login = { login?: string } | null | undefined
type Named = { name?: string } | null | undefined

const login = (who: Login): string => who?.login ?? 'unknown'
const names = (list: readonly Named[] | undefined): string[] =>
  (list ?? []).map(one => one?.name ?? '').filter(Boolean)
const logins = (list: readonly Login[] | undefined): string[] =>
  (list ?? []).map(login)

/** Runs `gh` with the given arguments in the session's directory; raises on a non-zero exit. */
export async function gh(
  $: EngineInterface,
  args: readonly string[],
  stdin?: string,
): Promise<string> {
  const ran = await $.process.run(['gh', ...args], {
    timeoutMs: 60_000,
    ...(stdin === undefined ? {} : { stdin }),
  })
  if (ran.exitCode !== 0) {
    const reason = (ran.stderr || ran.stdout).trim().split('\n')[0]
    throw new Error(reason || `gh exited with code ${ran.exitCode}`)
  }

  return ran.stdout
}

async function ghJson<T>($: EngineInterface, args: readonly string[]): Promise<T> {
  return JSON.parse(await gh($, args)) as T
}

export async function repoView($: EngineInterface): Promise<RepoInfo> {
  return ghJson<RepoInfo>($, ['repo', 'view', '--json', 'nameWithOwner,url'])
}

const LIST_FIELDS = 'number,title,state,labels,assignees,author,updatedAt'

export const FILTER_ARGS: Record<string, readonly string[]> = {
  open: ['--state', 'open'],
  assigned: ['--state', 'open', '--assignee', '@me'],
  authored: ['--state', 'open', '--author', '@me'],
  closed: ['--state', 'closed'],
  all: ['--state', 'all'],
}

type RawRow = {
  number: number
  title: string
  state: string
  labels?: Named[]
  assignees?: Login[]
  author?: Login
  updatedAt: string
}

export async function issueList(
  $: EngineInterface,
  repo: string,
  filter: string,
): Promise<IssueRow[]> {
  const rows = await ghJson<RawRow[]>($, [
    'issue', 'list', '--repo', repo, '--limit', '100', '--json', LIST_FIELDS,
    ...(FILTER_ARGS[filter] ?? FILTER_ARGS.open ?? []),
  ])

  return rows.map(row => ({
    number: row.number,
    title: row.title,
    state: row.state,
    labels: names(row.labels),
    assignees: logins(row.assignees),
    author: login(row.author),
    updatedAt: row.updatedAt,
  }))
}

const VIEW_FIELDS =
  'number,title,body,state,stateReason,labels,assignees,author,createdAt,url,comments'

type RawDetail = RawRow & {
  body?: string
  stateReason?: string
  createdAt: string
  url: string
  comments?: { author?: Login; body?: string; createdAt: string }[]
}

export async function issueView(
  $: EngineInterface,
  repo: string,
  number: number,
): Promise<IssueDetail> {
  const raw = await ghJson<RawDetail>($, [
    'issue', 'view', String(number), '--repo', repo, '--json', VIEW_FIELDS,
  ])
  const comments: IssueComment[] = (raw.comments ?? []).map(c => ({
    author: login(c.author),
    body: c.body ?? '',
    createdAt: c.createdAt,
  }))

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state,
    stateReason: raw.stateReason ?? '',
    labels: names(raw.labels),
    assignees: logins(raw.assignees),
    author: login(raw.author),
    createdAt: raw.createdAt,
    url: raw.url,
    comments,
  }
}

export async function labelList($: EngineInterface, repo: string): Promise<string[]> {
  const rows = await ghJson<Named[]>($, [
    'label', 'list', '--repo', repo, '--limit', '100', '--json', 'name',
  ])

  return names(rows)
}

/** Creates an issue and returns its number, parsed from the URL that gh prints. */
export async function issueCreate(
  $: EngineInterface,
  repo: string,
  title: string,
  body: string,
  labels: readonly string[],
): Promise<number> {
  const out = await gh(
    $,
    [
      'issue', 'create', '--repo', repo, '--title', title, '--body-file', '-',
      ...labels.flatMap(label => ['--label', label]),
    ],
    body,
  )
  const match = /\/issues\/(\d+)/.exec(out)
  if (!match?.[1]) throw new Error(`gh issue create: no issue URL in output: ${out.trim()}`)

  return Number(match[1])
}

export async function issueComment(
  $: EngineInterface,
  repo: string,
  number: number,
  body: string,
): Promise<void> {
  await gh($, ['issue', 'comment', String(number), '--repo', repo, '--body-file', '-'], body)
}

export async function issueClose(
  $: EngineInterface,
  repo: string,
  number: number,
  reason: 'completed' | 'not planned',
): Promise<void> {
  await gh($, ['issue', 'close', String(number), '--repo', repo, '--reason', reason])
}

export async function issueReopen(
  $: EngineInterface,
  repo: string,
  number: number,
): Promise<void> {
  await gh($, ['issue', 'reopen', String(number), '--repo', repo])
}
