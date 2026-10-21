export interface ProjectEntry { name: string; path: string; directory: boolean }
export interface ProjectListing { root: string; path: string; entries: ProjectEntry[]; truncated: boolean }
/**
 * text: the editor. image: a data URL. pdf: base64. html: a page Quick Look made of a document (Word, Excel,
 * Keynote…), shown in a sandbox with no scripts. video/audio: a termfile: URL the player streams from.
 * none: macOS has no preview for it (an archive, say); content says so.
 */
export interface ProjectPreview { path: string; type: 'text' | 'image' | 'pdf' | 'html' | 'video' | 'audio' | 'none'; content: string; version?: string }
