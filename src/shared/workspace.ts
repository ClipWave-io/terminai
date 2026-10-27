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
  url: string; email?: string; password: string; name?: string; inviteToken?: string; companyName?: string
}
export interface WorkspaceNote {
  id: string; ownerId: string; visibility: 'private' | 'company'; title: string; body: string; status: 'open' | 'done'
  assigneeId: string | null; position: number; updatedBy?: string; updatedByName?: string; createdAt: string; updatedAt: string
}
/** An invitation arrives as a link (…/#invite=TOKEN) or the bare token; both work. */
export function inviteTokenOf(value: string): string {
  const raw = value.trim(), match = raw.match(/invite=([A-Za-z0-9_-]{43})/)
  return match ? match[1] : raw
}
export interface McpSetupResult { id: string; status: 'configured' | 'needs-setup' | 'error'; message: string }
