import type { EngineInterface } from 'claude-code'

import type {
  FieldDef,
  FieldKind,
  FieldValue,
  IssueComment,
  IssueDetail,
  IssueExtras,
  IssueRef,
  IssueRow,
  Milestone,
  NewIssue,
  ProjectItem,
  RepoInfo,
  RepoOptions,
} from '../types'

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

/** Runs a GraphQL query or mutation, the body passed through stdin so no value needs escaping. */
async function graphql<T>(
  $: EngineInterface,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const out = JSON.parse(
    await gh($, ['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables })),
  ) as { data?: T }
  if (!out.data) throw new Error('GraphQL: no data in the response')

  return out.data
}

const splitRepo = (repo: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, name }
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

// projectItems is left out: reading it needs the read:project scope, and without that scope gh
// fails the whole query. Projects are read by issueProjects, on their own.
const VIEW_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'stateReason', 'labels', 'assignees', 'author',
  'createdAt', 'url', 'comments', 'issueType', 'milestone', 'parent', 'subIssues',
  'subIssuesSummary', 'blockedBy', 'blocking',
].join(',')

type RawRef = { number?: number; title?: string; state?: string; url?: string } | null | undefined
type RawRefs = { nodes?: RawRef[] } | null | undefined

const ref = (raw: RawRef): IssueRef | null =>
  raw?.number
    ? { number: raw.number, title: raw.title ?? '', state: raw.state ?? '', url: raw.url ?? '' }
    : null
const refs = (raw: RawRefs): IssueRef[] =>
  (raw?.nodes ?? []).map(ref).filter((r): r is IssueRef => r !== null)

type RawDetail = RawRow & {
  id?: string
  body?: string
  stateReason?: string
  createdAt: string
  url: string
  comments?: { author?: Login; body?: string; createdAt: string }[]
  issueType?: { name?: string } | null
  milestone?: { title?: string; dueOn?: string | null } | null
  parent?: RawRef
  subIssues?: RawRefs
  subIssuesSummary?: { completed?: number; total?: number } | null
  blockedBy?: RawRefs
  blocking?: RawRefs
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
  const subIssues = refs(raw.subIssues)

  return {
    id: raw.id ?? '',
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
    type: raw.issueType?.name ?? '',
    milestone: raw.milestone?.title
      ? { title: raw.milestone.title, dueOn: raw.milestone.dueOn ?? '' }
      : null,
    parent: ref(raw.parent),
    subIssues,
    subIssuesDone:
      raw.subIssuesSummary?.completed ?? subIssues.filter(s => s.state === 'CLOSED').length,
    blockedBy: refs(raw.blockedBy),
    blocking: refs(raw.blocking),
  }
}

/** The project boards the issue is on, with its status on each; needs the read:project scope. */
export async function issueProjects(
  $: EngineInterface,
  repo: string,
  number: number,
): Promise<ProjectItem[]> {
  const raw = await ghJson<{ projectItems?: { title?: string; status?: Named }[] }>($, [
    'issue', 'view', String(number), '--repo', repo, '--json', 'projectItems',
  ])

  return (raw.projectItems ?? [])
    .filter(p => p.title)
    .map(p => ({ title: p.title ?? '', status: p.status?.name ?? '' }))
}

const VALUE_FIELD = (kind: string) => `field { ... on IssueField${kind} { id name } }`

const EXTRAS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      issueFieldValues(first: 50) {
        nodes {
          __typename
          ... on IssueFieldTextValue { value ${VALUE_FIELD('Text')} }
          ... on IssueFieldNumberValue { value ${VALUE_FIELD('Number')} }
          ... on IssueFieldDateValue { value ${VALUE_FIELD('Date')} }
          ... on IssueFieldSingleSelectValue { name optionId ${VALUE_FIELD('SingleSelect')} }
          ... on IssueFieldMultiSelectValue { options { id name } ${VALUE_FIELD('MultiSelect')} }
        }
      }
      linkedBranches(first: 20) { nodes { ref { name } } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        nodes { number title state isDraft url }
      }
    }
  }
}`

type RawFieldValue = {
  value?: string | number | null
  name?: string
  optionId?: string
  options?: { id?: string; name?: string }[]
  field?: { id?: string; name?: string } | null
}

type RawExtras = {
  repository?: {
    issue?: {
      issueFieldValues?: { nodes?: (RawFieldValue | null)[] } | null
      linkedBranches?: { nodes?: ({ ref?: { name?: string } | null } | null)[] } | null
      closedByPullRequestsReferences?: {
        nodes?: ({ number: number; title?: string; state?: string; isDraft?: boolean; url?: string } | null)[]
      } | null
    } | null
  } | null
}

/** Issue fields and development (linked branches and pull requests), which `gh issue view` lacks. */
export async function issueExtras(
  $: EngineInterface,
  repo: string,
  number: number,
): Promise<IssueExtras> {
  const data = await graphql<RawExtras>($, EXTRAS_QUERY, { ...splitRepo(repo), number })
  const issue = data.repository?.issue
  const fields: FieldValue[] = []
  for (const v of issue?.issueFieldValues?.nodes ?? []) {
    if (!v?.field?.id) continue
    const optionIds = v.options
      ? v.options.map(o => o.id ?? '').filter(Boolean)
      : v.optionId
        ? [v.optionId]
        : []
    const value = v.options
      ? v.options.map(o => o.name ?? '').join(', ')
      : (v.name ?? (v.value === null || v.value === undefined ? '' : String(v.value)))
    fields.push({ fieldId: v.field.id, name: v.field.name ?? '', value, optionIds })
  }

  return {
    fields,
    branches: (issue?.linkedBranches?.nodes ?? [])
      .map(b => b?.ref?.name ?? '')
      .filter(Boolean),
    pulls: (issue?.closedByPullRequestsReferences?.nodes ?? [])
      .filter(p => p !== null)
      .map(p => ({
        number: p.number,
        title: p.title ?? '',
        state: p.state ?? '',
        isDraft: p.isDraft ?? false,
        url: p.url ?? '',
      })),
  }
}

const OPTIONS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issueTypes(first: 50) { nodes { name isEnabled } }
    issueFields(first: 50) {
      nodes {
        __typename
        ... on IssueFieldText { id name }
        ... on IssueFieldNumber { id name }
        ... on IssueFieldDate { id name }
        ... on IssueFieldSingleSelect { id name options { id name } }
        ... on IssueFieldMultiSelect { id name options { id name } }
      }
    }
    milestones(first: 50, states: OPEN, orderBy: { field: DUE_DATE, direction: ASC }) {
      nodes { title dueOn }
    }
  }
}`

type RawOptions = {
  repository?: {
    issueTypes?: { nodes?: ({ name?: string; isEnabled?: boolean } | null)[] } | null
    issueFields?: {
      nodes?: ({ __typename?: string; id?: string; name?: string; options?: { id?: string; name?: string }[] } | null)[]
    } | null
    milestones?: { nodes?: ({ title?: string; dueOn?: string | null } | null)[] } | null
  } | null
}

const KINDS: Record<string, FieldKind> = {
  IssueFieldText: 'text',
  IssueFieldNumber: 'number',
  IssueFieldDate: 'date',
  IssueFieldSingleSelect: 'single',
  IssueFieldMultiSelect: 'multi',
}

/**
 * What the repository offers to pick from: issue types and issue fields (both null where the
 * owner is a user, not an organization) and open milestones. Projects come from projectList.
 */
export async function repoOptions(
  $: EngineInterface,
  repo: string,
): Promise<Omit<RepoOptions, 'projects' | 'projectsNote'>> {
  const r = (await graphql<RawOptions>($, OPTIONS_QUERY, splitRepo(repo))).repository
  const types = r?.issueTypes
    ? (r.issueTypes.nodes ?? [])
        .filter(t => t?.name && t.isEnabled !== false)
        .map(t => t?.name ?? '')
    : null
  const fields: FieldDef[] | null = r?.issueFields
    ? (r.issueFields.nodes ?? []).flatMap(f => {
        const kind = KINDS[f?.__typename ?? '']
        if (!f?.id || !kind) return []
        return [{
          id: f.id,
          name: f.name ?? '',
          kind,
          options: (f.options ?? []).map(o => ({ id: o.id ?? '', name: o.name ?? '' })),
        }]
      })
    : null
  const milestones: Milestone[] = (r?.milestones?.nodes ?? [])
    .filter(m => m?.title)
    .map(m => ({ title: m?.title ?? '', dueOn: m?.dueOn ?? '' }))

  return { types, fields, milestones }
}

/** The open projects of the repository's owner, by title; needs the read:project scope. */
export async function projectList($: EngineInterface, repo: string): Promise<string[]> {
  const out = await ghJson<{ projects?: { title?: string; closed?: boolean }[] }>($, [
    'project', 'list', '--owner', splitRepo(repo).owner, '--limit', '100', '--format', 'json',
  ])

  return (out.projects ?? []).filter(p => p.title && !p.closed).map(p => p.title ?? '')
}

/** Turns gh's message for a missing token scope into the command that grants it. */
export function scopeHint(message: string): string {
  return /scope/i.test(message)
    ? 'Projects need the project scope: run `gh auth refresh -s project`.'
    : message
}

export async function labelList($: EngineInterface, repo: string): Promise<string[]> {
  const rows = await ghJson<Named[]>($, [
    'label', 'list', '--repo', repo, '--limit', '100', '--json', 'name',
  ])

  return names(rows)
}

/** Creates an issue and returns its number, parsed from the URL that gh prints. */
export async function issueCreate($: EngineInterface, repo: string, issue: NewIssue): Promise<number> {
  const out = await gh(
    $,
    [
      'issue', 'create', '--repo', repo, '--title', issue.title, '--body-file', '-',
      ...issue.labels.flatMap(label => ['--label', label]),
      ...(issue.type ? ['--type', issue.type] : []),
      ...(issue.milestone ? ['--milestone', issue.milestone] : []),
      ...issue.projects.flatMap(project => ['--project', project]),
      ...(issue.parent ? ['--parent', issue.parent] : []),
      ...issue.blockedBy.flatMap(n => ['--blocked-by', n]),
      ...issue.blocking.flatMap(n => ['--blocking', n]),
    ],
    issue.body,
  )
  const match = /\/issues\/(\d+)/.exec(out)
  if (!match?.[1]) throw new Error(`gh issue create: no issue URL in output: ${out.trim()}`)

  return Number(match[1])
}

/** `gh issue edit` with the given flags: type, milestone, projects and relationships. */
export async function issueEdit(
  $: EngineInterface,
  repo: string,
  number: number,
  flags: readonly string[],
): Promise<void> {
  await gh($, ['issue', 'edit', String(number), '--repo', repo, ...flags])
}

export async function issueId($: EngineInterface, repo: string, number: number): Promise<string> {
  const raw = await ghJson<{ id?: string }>($, [
    'issue', 'view', String(number), '--repo', repo, '--json', 'id',
  ])
  if (!raw.id) throw new Error(`#${number}: no node id`)

  return raw.id
}

/** One issue field's new value: option ids for a select, text for the rest; empty clears it. */
export type FieldSet = { field: FieldDef; text?: string; optionIds?: readonly string[] }

const fieldInput = ({ field, text = '', optionIds = [] }: FieldSet): Record<string, unknown> => {
  const base = { fieldId: field.id }
  if (field.kind === 'single' || field.kind === 'multi') {
    if (optionIds.length === 0) return { ...base, delete: true }
    return field.kind === 'single'
      ? { ...base, singleSelectOptionId: optionIds[0] }
      : { ...base, multiSelectOptionIds: optionIds }
  }
  const value = text.trim()
  if (!value) return { ...base, delete: true }
  if (field.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error(`${field.name}: "${value}" is not a number`)
    return { ...base, numberValue: n }
  }
  if (field.kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field.name}: use a YYYY-MM-DD date`)
    return { ...base, dateValue: value }
  }

  return { ...base, textValue: value }
}

const SET_FIELDS = `mutation($input: SetIssueFieldValueInput!) {
  setIssueFieldValue(input: $input) { clientMutationId }
}`

export async function issueSetFields(
  $: EngineInterface,
  issueNodeId: string,
  sets: readonly FieldSet[],
): Promise<void> {
  if (sets.length === 0) return
  await graphql($, SET_FIELDS, {
    input: { issueId: issueNodeId, issueFields: sets.map(fieldInput) },
  })
}

/** Creates a branch on GitHub linked to the issue (`gh issue develop`), without checking it out. */
export async function issueDevelop($: EngineInterface, repo: string, number: number): Promise<string> {
  return (await gh($, ['issue', 'develop', String(number), '--repo', repo])).trim()
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
