import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from the GitHub releases of ClipWave-io/terminai (publish in package.json). A new version
// downloads in the background; then a dialog offers to restart into it. Only the signed, installed app checks.
let asking = false
export function startUpdates(win: () => BrowserWindow | null): void {
  if (!app.isPackaged || process.env.TERMINAI_TEST_BUILD) return
  // From TerminAI's server (it fetches GitHub's release through the API), so a GitHub download outage never blocks updates.
  autoUpdater.setFeedURL({ provider: 'generic', url: 'https://terminai.xyz/updates' })
  autoUpdater.autoDownload = true
  // Installed only when the person clicks Restart now: never by itself on quit.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-downloaded', async info => {
    if (asking) return
    asking = true
    const options = { type: 'info' as const, buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `TerminAI ${info.version} is ready`,
      detail: 'Restart to update. Your tabs come back after the restart; choose Later and it waits until you restart from TerminAI › Check for Updates….' }
    const owner = win()
    const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    asking = false
    if (response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on('error', error => console.error('Update check failed:', String(error?.message ?? error).split('\n')[0]))
  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 10_000)
  setInterval(check, 4 * 60 * 60 * 1000)
}
/** "Check for Updates…": the result as a short line for Settings (and a dialog from the menu when there is nothing new). */
export async function checkForUpdatesNow(owner: BrowserWindow | null, quiet = false): Promise<string> {
  if (!app.isPackaged) { if (!quiet) await dialog.showMessageBox({ message: 'Updates work in the installed app only.' }); return 'Updates work in the installed app only.' }
  const result = await autoUpdater.checkForUpdates().catch(error => ({ error: String(error?.message ?? error) }))
  if (!result || 'error' in result) {
    // One readable line, never a stack or headers: the server's status if it had one.
    const raw = result && 'error' in result ? result.error : '', code = /HttpError: (\d{3})/.exec(raw)?.[1]
    const why = code ? `The update server answered ${code}.` : raw.split('\n')[0].replace(/\s*\(?https?:\/\/\S+/g, '').slice(0, 120) || 'No answer.'
    if (!quiet) void dialog.showMessageBox({ type: 'warning', message: 'Could not check for updates.', detail: `${why}\nTry again in a few minutes.` })
    return `Could not check: ${why}`
  }
  if (!result.isUpdateAvailable) {
    if (!quiet) { const options = { message: 'TerminAI is up to date', detail: `You have version ${app.getVersion()}.` }; if (owner) await dialog.showMessageBox(owner, options); else await dialog.showMessageBox(options) }
    return `Up to date (${app.getVersion()}).`
  }
  return `TerminAI ${result.updateInfo.version} is downloading: it asks to restart when it is ready.`
}
