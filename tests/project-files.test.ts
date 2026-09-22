import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectFiles } from '../src/main/project-files'

test('project file previews are root-scoped, bounded and inert', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'terminai-files-test-'))
  const root = join(folder, 'project'); await mkdir(root)
  await writeFile(join(folder, 'outside.txt'), 'private')
  await writeFile(join(root, 'README.md'), '<script>window.executed=true</script>')
  await writeFile(join(root, 'image.png'), Buffer.from([137,80,78,71,13,10,26,10]))
  await writeFile(join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
  await writeFile(join(root, 'binary'), Buffer.from([0,1,2]))
  await symlink(join(folder, 'outside.txt'), join(root, 'link'))
  await symlink(folder, join(root, 'escape'))
  const files = new ProjectFiles()
  try {
    await assert.rejects(files.preview('README.md'), /Choose/)
    await files.selectRoot(root)
    const listing = await files.list('')
    assert.equal(listing.entries.some(entry => entry.name === 'link' || entry.name === 'escape'), false)
    assert.deepEqual(await files.preview('README.md'), { path: 'README.md', type: 'text', content: '<script>window.executed=true</script>' })
    assert.match((await files.preview('image.png')).content, /^data:image\/png;base64,/)
    for (const name of ['../outside.txt', join(folder, 'outside.txt'), 'link', 'escape/outside.txt']) await assert.rejects(files.preview(name))
    await assert.rejects(files.list('../'), /outside/)
    await assert.rejects(files.preview('large.txt'), /1 MB/)
    await assert.rejects(files.preview('binary'), /binary/)
    await assert.rejects(files.preview(''), /regular/)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
