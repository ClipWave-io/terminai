import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectListing, ProjectPreview } from '../shared/project-files'

/** A capability granted by the native folder picker, never by renderer paths. */
export class ProjectFiles {
  private root = ''
  async selectRoot(path: string): Promise<string> {
    const root = await realpath(path)
    if (!(await lstat(root)).isDirectory()) throw new Error('Select a project folder.')
    this.root = root
    return root
  }
  private async scoped(input: unknown): Promise<string> {
    if (!this.root) throw new Error('Choose a project folder first.')
    if (typeof input !== 'string' || input.includes('\0') || isAbsolute(input)) throw new Error('Invalid project path.')
    const target = resolve(this.root, input)
    const rel = relative(this.root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path is outside the selected project.')
    let part = this.root
    for (const segment of rel.split(sep).filter(Boolean)) {
      part = resolve(part, segment)
      if ((await lstat(part)).isSymbolicLink()) throw new Error('Symbolic links are not opened in the file viewer.')
    }
    const canonical = await realpath(target)
    if (canonical !== this.root && !canonical.startsWith(this.root + sep)) throw new Error('Path is outside the selected project.')
    return canonical
  }
  async list(path: string): Promise<ProjectListing> {
    const directory = await this.scoped(path)
    const all = (await readdir(directory, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    return { root: this.root, path, truncated: all.length > 500, entries: all.slice(0, 500).map(entry => ({ name: entry.name, path: relative(this.root, resolve(directory, entry.name)), directory: entry.isDirectory() })) }
  }
  async preview(path: string): Promise<ProjectPreview> {
    const target = await this.scoped(path)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('Only regular files can be previewed.')
      if (info.size > 8 * 1024 * 1024) throw new Error('Preview limit is 8 MB for images and 1 MB for text.')
      const verified = await this.scoped(path)
      const current = await lstat(verified)
      if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('The file changed while opening. Try again.')
      const bytes = Buffer.alloc(Math.min(info.size + 1, 8 * 1024 * 1024 + 1))
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const data = bytes.subarray(0, bytesRead)
      let mime = ''
      if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png'
      else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg'
      else if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) mime = 'image/gif'
      else if (data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') mime = 'image/webp'
      if (mime) return { path, type: 'image', content: `data:${mime};base64,${data.toString('base64')}` }
      if (bytesRead > 1024 * 1024) throw new Error('Text preview limit is 1 MB.')
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('This binary file cannot be previewed.') }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('This binary file cannot be previewed.')
      return { path, type: 'text', content }
    } finally { await handle.close() }
  }
}
