# Customising this terminal

You are Claude Code, opened from inside **TerminAI** — the very terminal window you are
running in. The person talking to you wants to change how it looks or feels. Your job is to make
that change, apply it, and relaunch the app so they see it immediately.

Read this file first. It tells you what is safe to change, what must keep working, and how to
ship a change.

---

## 1. Make the change, then run one command

```bash
bash scripts/apply.sh
```

That builds, reinstalls to `/Applications`, and relaunches the app. **The app will quit and
reopen — including this terminal tab.** Tell the user that before you run it, and expect your
own session to end. The script detaches itself precisely so it survives the app dying.

Do not try to relaunch any other way. Do not `npm run dev` — the user is running the packaged
build from the Dock, not a dev server.

---

## 2. What you can freely change — all of the design

| Want to change | File |
|---|---|
| Colours, both palettes, adding a new theme | `src/shared/themes.ts` |
| Layout, spacing, radii, shadows, fonts, animation | `src/renderer/styles.css` |
| **Which side the sidebar sits on** | the `railSide` pref (`⌥⌘S`), not CSS — see `types.ts` |
| Hiding the sidebar / voice dock | the `railHidden` / `voiceDockHidden` prefs (`⌘S` / `⌘D`) |
| What a tab row shows | `src/renderer/components/TabRail.tsx` |
| The grid view of tabs | `src/renderer/components/TabGrid.tsx` |
| The audio player at the bottom | `src/renderer/components/VoiceDock.tsx` |
| The settings panel | `src/renderer/components/SettingsSheet.tsx` |
| Window shape, vibrancy, traffic lights | `BrowserWindow` options in `src/main/index.ts` |
| Keyboard shortcuts | the `onKey` handler in `src/renderer/App.tsx` |

Every colour in the CSS comes from a custom property that `App.tsx` writes from the active
theme (`--bg`, `--surface`, `--pane`, `--fg`, `--dim`, `--accent`, `--border`, `--shadow`,
`--ok`, `--warn`, `--danger`). Adding a theme means adding an entry to `THEMES` in
`themes.ts` — the whole UI follows automatically. Prefer that over hardcoding a colour.

Adding a **new** persisted setting means adding it to `Prefs` in `src/shared/types.ts` and to
`DEFAULT_PREFS`; `store.ts` merges one level deep, so old prefs files keep working.

---

## 3. What must keep working — do not break these

These are load-bearing. Each one failed silently at least once during development, so they are
written down rather than left to be rediscovered.

1. **The PTY is the product.** `src/main/pty.ts` spawns the user's login shell. Do not change
   `TERM=xterm-256color`, `COLORTERM=truecolor`, or the `$SHELL -l` invocation. Claude Code is a
   fullscreen TUI and degrades badly without them.

2. **Do not disable xterm's alt-screen, mouse reporting, or bracketed paste**, and keep the
   `FitAddon` → `pty.resize(cols, rows)` path in `TerminalPane.tsx`. Without the resize
   propagation, every TUI renders at the wrong size.

3. **Terminals for inactive tabs stay mounted**, hidden with `visibility`, never unmounted. If
   you switch to conditional rendering, background sessions stop drawing and scrollback is lost.

4. **The PTY environment strips `CLAUDE_CODE_*` markers.** If the app was launched from inside a
   Claude Code session, passing those on makes every `claude` in a tab think it is a child
   session, which disables transcript saving — and then the Stop hook has no transcript, so the
   voice silently stops working.

5. **Voice pipeline** (`src/main/voice.ts`): it stat-polls `~/.claude/spoken.txt` rather than
   using `fs.watch`, which misses in-place rewrites on macOS. `say` gets its text as an argv
   argument, never stdin. Audio is served over the `clipaudio://` scheme, not `file://`. Output
   must be a format Chromium can decode — WAV or MP3, never AIFF.

6. **Prefs are written write-then-rename.** A plain write leaves a window where a torn file
   resets every preference to its default.

If the user asks for something that would break one of these, say so and offer the nearest thing
that does not.

---

## 4. Renaming the app

`build.productName` in `package.json` is the app's name and therefore the bundle name
(`TerminAI.app`). `scripts/apply.sh` reads it from there — never hardcode the bundle name
anywhere, and if you change it, tell the user their Dock icon points at the old path and will
need re-adding. Renaming without updating the installer once left `/Applications` with no app
at all.

## 5. Working style

- Change the design, not the plumbing. If a request only needs CSS, only touch CSS.
- Run `npx tsc --noEmit` before applying; it catches most mistakes for free.
- Keep **every** theme working. `THEMES` in `themes.ts` currently has 12 entries; a new colour
  needs a value in each, light ones included, or that theme silently loses it.
- After `scripts/apply.sh`, the app reopens with the previous tabs restored.
- The user's own version is just this git repo. Suggest they commit changes they like, so a
  later rebuild does not lose them.
