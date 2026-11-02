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

export type IssueDetail = {
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
}

export type IssueView = 'list' | 'detail' | 'new'
export type IssueFilter = 'open' | 'assigned' | 'authored' | 'closed' | 'all'
export type IssueDraft = { title: string; body: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'gh-issues': {
      repo: Shaped<RepoInfo | null>
      view: IssueView
      filter: IssueFilter
      issues: Shaped<IssueRow[]>
      detail: Shaped<IssueDetail | null>
      busy: string
      error: string
      draft: Shaped<IssueDraft>
      comment: string
      labels: Shaped<string[]>
    }
  }
}
