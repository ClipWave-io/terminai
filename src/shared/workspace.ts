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
  url: string; email?: string; password: string; name?: string; inviteToken?: string
}
export interface McpSetupResult { client?: 'codex' | 'claude'; id: string; status: 'configured' | 'needs-setup' | 'error'; message: string }
