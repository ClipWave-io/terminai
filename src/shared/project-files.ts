export interface ProjectEntry { name: string; path: string; directory: boolean }
export interface ProjectListing { root: string; path: string; entries: ProjectEntry[]; truncated: boolean }
export interface ProjectPreview { path: string; type: 'text' | 'image' | 'pdf'; content: string; version?: string }
