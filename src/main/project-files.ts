import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readdir, realpath, rename, rm, unlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, relative, resolve, sep, dirname, join } from 'node:path'
import type { ProjectListing, ProjectPreview } from '../shared/project-files'

const TEXT_LIMIT = 20 * 1024 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024
const HTML_LIMIT = 40 * 1024 * 1024

export const MEDIA_SCHEME = 'termfile'
export const MEDIA_TYPES: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff',
}
// Photos the renderer cannot draw: macOS's sips makes a JPEG of them.
const SIPS = new Set(['heic', 'heif', 'tif', 'tiff', 'bmp', 'psd', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'icns', 'jp2', 'tga', 'exr', 'avif'])
// Documents shown the way the Finder's space bar shows them, even the ones that are text underneath (RTF).
const QUICK_LOOK = new Set(['rtf', 'rtfd', 'doc', 'docx', 'dot', 'dotx', 'odt', 'pages', 'numbers', 'key', 'xls', 'xlsx', 'xlsm', 'ods', 'ppt', 'pptx', 'odp', 'epub'])
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', css: 'text/css', svg: 'image/svg+xml', webp: 'image/webp' }

/** Media files the player may stream, by a token that names one file and nothing else. */
const media = new Map<string, string>()
export const mediaFile = (token: string) => media.get(token)

function run(file: string, args: string[], timeout = 30_000): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout }, err => err ? reject(err) : resolve()))
}
/** Quick Look's page with its stylesheets and pictures put inside it: the sandbox it is shown in loads nothing. */
async function inlined(html: string, dir: string, names: string[]): Promise<string> {
  const data = async (name: string) => (await readFile(join(dir, name))).toString('base64')
  for (const name of names) {
    const ext = extname(name).slice(1).toLowerCase(), quoted = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (ext === 'css') {
      const css = await readFile(join(dir, name), 'utf8')
      html = html.replace(new RegExp(`<link[^>]+href="(?:cid:)?${quoted}"[^>]*>`, 'gi'), () => `<style>${css}</style>`)
    } else if (IMAGE_MIME[ext]) {
      const url = `data:${IMAGE_MIME[ext]};base64,${await data(name)}`
      html = html.replace(new RegExp(`(src|href)="(?:cid:)?${quoted}"`, 'g'), (_m, attr) => `${attr}="${url}"`)
    }
  }
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, '')
}
/** What the Finder shows on the space bar: a PDF, an HTML page, or at least its picture of the file. */
async function quickLook(file: string, path: string): Promise<ProjectPreview> {
  const dir = await mkdtemp(join(tmpdir(), 'terminai-ql-'))
  try {
    await run('/usr/bin/qlmanage', ['-p', '-o', dir, file]).catch(() => {})
    const out = join(dir, `${basename(file)}.qlpreview`)
    const names = await readdir(out).catch(() => [] as string[])
    if (names.includes('Preview.pdf')) return { path, type: 'pdf', content: await readFile(join(out, 'Preview.pdf'), 'base64') }
    if (names.includes('Preview.html')) {
      let html = await readFile(join(out, 'Preview.html'), 'utf8')
      // Pages: the whole page is one PDF in an <img>.
      const page = /<img[^>]+src="([^"]+\.pdf)"/i.exec(html)?.[1]
      if (page && names.includes(page)) return { path, type: 'pdf', content: await readFile(join(out, page), 'base64') }
      // Numbers: the sheet is an attachment that a scripted page frames.
      const sheet = /<iframe[^>]+src="([^"]+\.html)"/i.exec(html)?.[1]
      if (sheet && names.includes(sheet)) html = await readFile(join(out, sheet), 'utf8')
      const content = await inlined(html, out, names)
      if (Buffer.byteLength(content) > HTML_LIMIT) throw new Error('This document is too large to preview here.')
      return { path, type: 'html', content }
    }
    // Short: for a file it has no picture of (an archive), qlmanage -t sits ~25 s before giving up.
    await run('/usr/bin/qlmanage', ['-t', '-s', '1600', '-o', dir, file], 5_000).catch(() => {})
    const thumb = await readFile(join(dir, `${basename(file)}.png`)).catch(() => null)
    if (thumb) return { path, type: 'image', content: `data:image/png;base64,${thumb.toString('base64')}` }
    return { path, type: 'none', content: 'macOS has no preview for this kind of file.' }
  } finally { await rm(dir, { recursive: true, force: true }) }
}
async function viaSips(file: string, path: string): Promise<ProjectPreview> {
  const dir = await mkdtemp(join(tmpdir(), 'terminai-sips-'))
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '2400', file, '--out', join(dir, 'preview.jpg')])
    return { path, type: 'image', content: `data:image/jpeg;base64,${await readFile(join(dir, 'preview.jpg'), 'base64')}` }
  } catch { return quickLook(file, path) } finally { await rm(dir, { recursive: true, force: true }) }
}

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
  /** The real file behind a project path, for "Open with the default app". */
  async resolved(path: string): Promise<string> { return this.scoped(path) }
  async preview(path: string): Promise<ProjectPreview> {
    const target = await this.scoped(path)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new Error('Only regular files can be previewed.')
      const ext = extname(target).slice(1).toLowerCase()
      if (MEDIA_TYPES[ext]) {
        const token = randomUUID()
        media.set(token, target)
        // The last few only: a player still open keeps working, the rest are forgotten.
        for (const old of [...media.keys()].slice(0, -20)) media.delete(old)
        return { path, type: MEDIA_TYPES[ext].startsWith('video/') ? 'video' : 'audio', content: `${MEDIA_SCHEME}://media/${token}` }
      }
      if (QUICK_LOOK.has(ext)) return await quickLook(target, path)
      if (SIPS.has(ext)) return await viaSips(target, path)
      if (ext === 'svg' && info.size <= IMAGE_LIMIT) return { path, type: 'image', content: `data:image/svg+xml;base64,${await readFile(target, 'base64')}` }
      if (info.size > TEXT_LIMIT) return await quickLook(target, path)
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
      if (data.subarray(0, 5).toString() === '%PDF-') return { path, type: 'pdf', content: data.toString('base64') }
      let mime = ''
      if (data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png'
      else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mime = 'image/jpeg'
      else if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) mime = 'image/gif'
      else if (data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP') mime = 'image/webp'
      if (mime && bytesRead > IMAGE_LIMIT) throw new Error('This image exceeds the 8 MB preview limit.')
      if (mime) return { path, type: 'image', content: `data:${mime};base64,${data.toString('base64')}` }
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { return await quickLook(target, path) }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return await quickLook(target, path)
      return { path, type: 'text', content, version: createHash('sha256').update(data).digest('hex') }
    } finally { await handle.close() }
  }
}
