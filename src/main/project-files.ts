import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename, unlink, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname, join } from 'node:path'
import type { ProjectListing, ProjectPreview } from '../shared/project-files'

const TEXT_LIMIT = 20 * 1024 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024

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
      if ((await lstat(part)).isSymbolicLink()) throw new Error('Symbolic links are not opened in the editor.')
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
  async save(path: string, content: string, version: string): Promise<ProjectPreview> {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > TEXT_LIMIT || typeof version !== 'string') throw new Error('This text file exceeds the 20 MB editor limit.')
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('Only text files can be saved.')
    const target = await this.scoped(path)
    const current = await this.preview(path)
    if (current.type !== 'text' || current.version !== version) throw new Error('This file changed on disk. Reload it before saving; your edits have been kept.')
    const stat = await lstat(target)
    const bytes = await readFile(target)
    if (createHash('sha256').update(bytes).digest('hex') !== version) throw new Error('This file changed on disk. Reload it before saving.')
    // Preserve UTF-8 BOM and CRLF line endings when editing an existing file.
    const text = bytes.includes(Buffer.from('\r\n')) ? content.replace(/\r?\n/g, '\r\n') : content
    const data = Buffer.concat([bytes.subarray(0,3).equals(Buffer.from([239,187,191])) ? Buffer.from([239,187,191]) : Buffer.alloc(0), Buffer.from(text)])
    if (data.length > TEXT_LIMIT) throw new Error('This text file exceeds the 20 MB editor limit after preserving its line endings.')
    const temp = join(dirname(target), `.terminai-save-${randomUUID()}`)
    let file
    try {
      file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, stat.mode & 0o777)
      await file.writeFile(data); await file.sync(); await file.close(); file = undefined
      if (await this.scoped(path) !== target || (await this.preview(path)).version !== version) throw new Error('This file changed on disk. Your edits have been kept.')
      await rename(temp, target)
      return await this.preview(path)
    } finally { await file?.close(); await unlink(temp).catch(()=>{}) }
  }
  async preview(path: string): Promise<ProjectPreview> {
    const target = await this.scoped(path)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('Only regular files can be previewed.')
      if (info.size > TEXT_LIMIT) throw new Error('This file exceeds the editor limit: 20 MB for text, 8 MB for images.')
      const verified = await this.scoped(path)
      const current = await lstat(verified)
      if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('The file changed while opening. Try again.')
      const bytes = Buffer.alloc(info.size + 1)
      let bytesRead = 0
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
        if (!chunk.bytesRead) break
        bytesRead += chunk.bytesRead
      }
      const after = await handle.stat()
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('The file changed while opening. Try again.')
      const data = bytes.subarray(0, bytesRead)
      let mime = ''
      if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png'
      else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg'
      else if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) mime = 'image/gif'
      else if (data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') mime = 'image/webp'
      if (mime && bytesRead > IMAGE_LIMIT) throw new Error('This image exceeds the 8 MB preview limit.')
      if (mime) return { path, type: 'image', content: `data:${mime};base64,${data.toString('base64')}` }
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('This binary file cannot be previewed.') }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('This binary file cannot be previewed.')
      return { path, type: 'text', content, version: createHash('sha256').update(data).digest('hex') }
    } finally { await handle.close() }
  }
}
