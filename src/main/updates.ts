import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from the GitHub releases of ClipWave-io/terminai (publish in package.json). A new version
// downloads in the background; then a dialog offers to restart into it. Only the signed, installed app checks.
let asking = false
export function startUpdates(win: () => BrowserWindow | null): void {
  if (!app.isPackaged || process.env.TERMINAI_TEST_BUILD) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', async info => {
    if (asking) return
    asking = true
    const options = { type: 'info' as const, buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `TerminAI ${info.version} is ready`,
      detail: 'Restart to update. Your tabs come back after the restart; choosing Later installs it the next time you quit.' }
    const owner = win()
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    asking = false
    if (response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', error => console.error('Update check failed:', error.message))
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 10_000)
  setInterval(check, 4 * 60 * 60 * 1000)
}
/** "Check for Updates…": says so when there is nothing new. */
export async function checkForUpdatesNow(owner: BrowserWindow | null): Promise<void> {
  if (!app.isPackaged) { await dialog.showMessageBox({ message: 'Updates work in the installed app only.' }); return }
  const result = await autoUpdater.checkForUpdates().catch(error => { void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: String(error?.message ?? error) }); return null })
  if (result && !result.isUpdateAvailable) {
    const options = { message: 'TerminAI is up to date', detail: `You have version ${app.getVersion()}.` }
    if (owner) await dialog.showMessageBox(owner, options); else await dialog.showMessageBox(options)
  }
}
