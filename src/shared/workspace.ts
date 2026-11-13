export const DEFAULT_WORKSPACE_URL = 'https://terminai-manager-production.up.railway.app'

export interface WorkspaceCompany {
  id: string; name: string; role: string; classification: string
  defaultVisibility: 'owner' | 'company'; allowCompanySharing: boolean
}
export interface WorkspaceIdentity {
  user: { id: string; email: string; name: string }
  companies: WorkspaceCompany[]
}
export interface WorkspaceState {
  url: string; signedIn: boolean; identity?: WorkspaceIdentity
}
export interface WorkspaceLogin {
  url: string; email?: string; password: string; name?: string; inviteToken?: string; companyName?: string; signup?: boolean
}
export interface WorkspaceNote {
  id: string; ownerId: string; visibility: 'private' | 'company'; title: string; body: string; status: 'open' | 'done'
  assigneeId: string | null; position: number; updatedBy?: string; updatedByName?: string; createdAt: string; updatedAt: string
  /** card: a task on the board; doc: a shared note, like Apple Notes, that can hold files. */
  kind?: 'card' | 'doc'; files?: WorkspaceNoteFile[]
  /** e.g. ManyMotions: the same product names as the To-do's */
  product?: string
}
export interface WorkspaceNoteFile { id: string; name: string; mime: string; size: number; createdAt: string }
/** A comment on a note: a thread (parentId null) or a reply in one. The can* flags are what the reader may do with it. */
export interface WorkspaceNoteComment {
  id: string; noteId: string; parentId: string | null; authorId: string | null; authorName: string; body: string; mentions: string[]
  createdAt: string; editedAt: string | null; resolvedAt: string | null; resolvedBy: string | null; resolvedByName: string | null
  mine: boolean; canEdit: boolean; canResolve: boolean
}
export type WorkspaceNoteAction = 'created' | 'edited' | 'product' | 'file_added' | 'file_removed' | 'commented' | 'resolved' | 'reopened' | 'deleted'
/** One thing done to a note, newest first. forMe: a comment on your note, a reply in your thread or an @mention of you. */
export interface WorkspaceNoteActivity {
  id: string; noteId: string; noteTitle: string; noteKind: 'card' | 'doc'; product: string; noteExists: boolean
  action: WorkspaceNoteAction; by: string | null; byName: string; at: string; forMe: boolean
  detail: { fields?: string[]; from?: string; to?: string; names?: string[]; count?: number; reply?: boolean; excerpt?: string; commentId?: string; mentioned?: number }
}
/** An invitation arrives as a link (…/#invite=TOKEN) or the bare token; both work. */
export function inviteTokenOf(value: string): string {
  const raw = value.trim(), match = raw.match(/invite=([A-Za-z0-9_-]{43})/)
  return match ? match[1] : raw
}
export interface McpSetupResult { id: string; status: 'configured' | 'needs-setup' | 'error'; message: string }
