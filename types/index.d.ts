export type RepoInfo = { nameWithOwner: string; url: string }

export type IssueRow = {
  number: number
  title: string
  state: string
  labels: string[]
  assignees: string[]
  author: string
  updatedAt: string
}

export type IssueComment = { author: string; body: string; createdAt: string }

/** Another issue this one is related to: its parent, a sub-issue, a blocker or one it blocks. */
export type IssueRef = { number: number; title: string; state: string; url: string }

export type Milestone = { title: string; dueOn: string }

export type IssueDetail = {
  /** The GraphQL node id, which setting issue fields needs. */
  id: string
  number: number
  title: string
  body: string
  state: string
  stateReason: string
  labels: string[]
  assignees: string[]
  author: string
  createdAt: string
  url: string
  comments: IssueComment[]
  /** The issue type's name, empty when none is set. */
  type: string
  milestone: Milestone | null
  parent: IssueRef | null
  subIssues: IssueRef[]
  subIssuesDone: number
  blockedBy: IssueRef[]
  blocking: IssueRef[]
}

export type FieldKind = 'text' | 'number' | 'date' | 'single' | 'multi'
export type FieldOption = { id: string; name: string }
/** An issue field an organization defines: Priority, Effort, Start date and so on. */
export type FieldDef = { id: string; name: string; kind: FieldKind; options: FieldOption[] }
/** One field's value on an issue, as text, with the option ids picked for a select. */
export type FieldValue = { fieldId: string; name: string; value: string; optionIds: string[] }

export type PullRef = { number: number; title: string; state: string; isDraft: boolean; url: string }
export type ProjectItem = { title: string; status: string }

/** What one issue has beyond `gh issue view`: field values and development. */
export type IssueExtras = { fields: FieldValue[]; branches: string[]; pulls: PullRef[] }

/** Read after the issue itself, each part on its own, so a missing scope hides only its part. */
export type IssueSide = {
  number: number
  extras: IssueExtras | null
  extrasNote: string
  projects: ProjectItem[] | null
  projectsNote: string
}

/** What the repository offers to pick from; types and fields are null where the owner is a user. */
export type RepoOptions = {
  types: string[] | null
  fields: FieldDef[] | null
  milestones: Milestone[]
  projects: string[] | null
  projectsNote: string
}

export type RelationKind = 'parent' | 'sub' | 'blockedBy' | 'blocking'

export type IssueView = 'list' | 'detail' | 'edit' | 'new'
export type IssueFilter = 'open' | 'assigned' | 'authored' | 'closed' | 'all'
export type IssueDraft = {
  title: string
  body: string
  labels: string[]
  type: string
  milestone: string
  projects: string[]
  /** Field id to its value: option ids for a select, one text for the rest. */
  fields: Record<string, string[]>
  parent: string
  blockedBy: string[]
  blocking: string[]
  /** Create a branch on GitHub linked to the issue once it exists (`gh issue develop`). */
  branch: boolean
}
/** What issueCreate passes to gh. */
export type NewIssue = Omit<IssueDraft, 'fields' | 'branch'>

declare module 'claude-code' {
  interface PluginState {
    'gh-issues': {
      repo: Shaped<RepoInfo | null>
      view: IssueView
      filter: IssueFilter
      issues: Shaped<IssueRow[]>
      detail: Shaped<IssueDetail | null>
      side: Shaped<IssueSide | null>
      options: Shaped<RepoOptions | null>
      busy: string
      error: string
      draft: Shaped<IssueDraft>
      comment: string
      labels: Shaped<string[]>
      relation: RelationKind
      relationInput: string
      /** Text typed into an issue field's box in the edit view, by field id, until it is set. */
      fieldText: Shaped<Record<string, string>>
      /** The title typed for a new milestone. */
      milestoneInput: string
    }
  }
}
