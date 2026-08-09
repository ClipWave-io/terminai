# TerminAI

A terminal that is easier on the eyes, and talks back. Built around long-running Claude Code
sessions: several of them, side by side, each one worth coming back to.

macOS on Apple Silicon only, and unsigned — see *Running it* below.

- **Tabs are rows down the left**, not a strip across the top.
- **Sessions come back the way you left them.** Each tab gets its own Claude Code session id, so
  reopening the app resumes *that tab's* conversation rather than whichever one happened to be
  most recent in the folder.
- **Optionally grouped by folder** — Settings → *Group by folder* buckets the sidebar under a
  heading per directory.
- **Rounded, low-contrast surfaces** — twelve palettes, none of them white-on-black.
- **Spoken summaries.** When a Claude Code turn ends, the one-line `SPOKEN:` summary is
  synthesized and played in a dock at the bottom of the window.
- **A real terminal.** One PTY per tab running your login shell, so zsh, git, vim, ssh and
  Claude Code all behave exactly as they do anywhere else.
- **A grid of every session** (`⌘G`) with a live text preview, how long each has been open and
  focused, a note you can keep against it, and drag-to-reorder for your own priority order.
- **Restyle it by asking.** Settings → *Customise the design* opens Claude Code in this app's
  own source with `DESIGN.md` loaded, then rebuilds and relaunches.

## Running it

```bash
git clone https://github.com/ilaiadaya/terminai.git
cd terminai
npm install     # approves the native install scripts electron + node-pty need
npm run dev     # hot-reloading development window
```

To build a real app:

```bash
npm run dist       # release/mac-arm64/TerminAI.app
npm run dist:dmg   # a .dmg to drag into Applications
```

To install a fresh build over the one in the Dock:

```bash
npm run dist
cp -R "release/mac-arm64/TerminAI.app" /Applications/
```

Quit the app before copying over it. Deleting the bundle of a *running* copy leaves the process
alive but unable to spawn new PTYs — node-pty execs `spawn-helper` out of the bundle, and new
tabs then fail silently until you relaunch.

The Dock entry points at `/Applications`, so it keeps working across rebuilds. The app is
unsigned; a locally built copy carries no quarantine flag and opens normally, but a copy that
has travelled through a download will need right-click → Open once.

Nothing is required beyond `npm install` — the voice falls back to macOS `say` with no key and
no setup, and Claude Code is only needed if you want the parts that talk to it.

## Icon

`build/icon.icns` is generated, not hand-drawn — re-run after changing the palette:

```bash
python3 scripts/make-icon.py   # needs Pillow
```

## How the voice part works

It reuses the setup already in `~/.claude` rather than replacing it:

| Piece | Owner | Role |
|---|---|---|
| `~/.claude/CLAUDE.md` | you | makes every response end with `SPOKEN: <one sentence>` |
| `~/.claude/speak-summary.sh` | you (a `Stop` hook) | writes that line to `~/.claude/spoken.txt` |
| `~/.claude/speak-file.sh` | you | speaks it on a global hotkey |
| **TerminAI** | this repo | watches `spoken.txt`, synthesizes, and plays it in-window |

Nothing here writes to `~/.claude`. The existing hotkey keeps working whether or not this app
is running, and the app keeps working if you delete the hotkey.

Three engines, tried in order and degrading rather than losing the clip:

1. **Local (Kokoro-82M on Apple MLX)** — the default. Free, on-device, no key, no per-character
   cost, works offline. Install with `bash scripts/setup-local-tts.sh` (~2 GB, Apple Silicon
   only). Related in spirit to LocalFlow, but the opposite direction: LocalFlow is speech-*to*-
   text, this is text-*to*-speech.
2. **ElevenLabs** — best quality, billed per character.
3. **macOS `say`** — always available, always last. `say` only has Apple's
*compact* voices unless premium ones are downloaded in System Settings → Accessibility → Spoken
Content, which is why it sounds robotic; ElevenLabs is the reason this app has a voice worth
listening to. It falls back to `say` on any network failure, so a dead connection degrades the
voice rather than losing the clip.

**The API key lives in the login Keychain, not a file.** This is not optional polish: an app
launched from the Dock inherits none of your shell environment, so a key in `.env` or `.zshrc`
is invisible to it. Set it in Settings, or from a shell:

```bash
security add-generic-password -U -s clipwave-term-elevenlabs -a clipwave-term -w "sk_..."
```

The voice dropdown in Settings lists your actual ElevenLabs library, fetched live, with a
Preview button that runs the real synthesis path.

Clips are cached as audio files under `~/Library/Application Support/clipwave-term/voice/`,
which is what makes replay, scrubbing and "save a copy" instant.

`SPOKEN:` stays visible in the terminal. Filtering it out of the output would mean rewriting a
raw PTY byte stream mid-flight, which breaks on redraws and partial reads.

## Keys

| | |
|---|---|
| `⌘T` / `⌘W` | new tab / close tab |
| `⇧⌘O` | new tab in a chosen folder |
| `⌘1`–`⌘9` | jump to tab |
| `⌃⇥` / `⌃⇧⇥` | cycle tabs |
| `⇧⌘L` | cycle to the next theme |
| `⇧⌘S` | play / replay the latest summary |
| `⌘+` / `⌘−` | font size |
| `⌘G` | grid of all sessions |
| `⌘,` | settings |

Drag the divider between the rail and the terminal to resize the sidebar; double-click it to
reset. The width is clamped to 150–460px and remembered.

Everything else falls through to the shell untouched, so Claude Code's own bindings still work.

## Layout

```
src/main/       PTY sessions, prefs, the spoken.txt watcher, TTS engines
src/preload/    the single contextBridge surface the renderer gets
src/renderer/   React UI: tab rail, terminal panes, voice dock, settings
src/shared/     types and the palettes
```

`~/Library/Application Support/clipwave-term/` holds prefs, saved tabs, the voice cache, the
per-tab `claude` shim and the session ids. The directory keeps the old name because Electron
keys it on package.json `name`, not the display name — renaming it would strand your prefs.

## Debugging

`CLIPWAVE_TERM_DEBUG=1` traces the summary pipeline to `/tmp/clipwave-term-voice.log`. The main
process's stdout is not reliably captured when the packaged app launches from Finder, so a file
is the only trace that always survives.

## Notes for future changes

- `say` gets its text as an **argv argument**, never on stdin. `say -f -` blocks forever waiting
  on a stdin that never closes and leaves a 4KB header-only WAV behind, which then plays as
  silence — and, once cached, plays as silence permanently. `assertHasAudio` exists to catch
  exactly that.
- Output is **WAVE/LEI16**, not `say`'s default AIFF, because Chromium cannot decode AIFF.
- Audio is served over a custom `clipaudio://` scheme, not `file://`, because the dev renderer is
  an `http://` origin and Chromium blocks `file://` subresources from one.
- The watcher **stat-polls** rather than using `fs.watch`. `fs.watch` on a single file misses
  events on macOS when the file is truncated and rewritten in place, which is exactly what
  `printf > spoken.txt` does.
- The PTY environment **strips `CLAUDE_CODE_*` markers**. If the app is launched from inside a
  Claude Code session it inherits them, every `claude` in a tab then believes it is a *child*
  session, transcript saving is silently disabled — and with no transcript the Stop hook writes
  nothing, so the voice goes quiet with no error anywhere.
- Per-tab conversation restore works through a **`claude` shim first on that tab's PATH**, which
  mints a uuid and passes `--session-id`. `claude --continue` resumes the newest conversation *in
  the folder*, so two tabs in one folder would otherwise fight over the same one. The shim takes
  itself off PATH before `exec`, and stays out of the way when you pass `-r`/`-c`/`--session-id`
  yourself. If `claude` is a shell function in your rc file the shim never runs and restore falls
  back to `--continue`.
- Session id files are **not** deleted on tab close — `killAll()` runs at quit and would destroy
  the ids the next launch needs. A 14-day sweep cleans them up instead.
- Folder labels come from a batched `lsof -a -w -d cwd` over every live pid on the existing 3s
  sweep, not one spawn per tab.
- Local TTS runs with `VIRTUAL_ENV` pointed at its venv. misaki shells out to `uv pip install`
  for its spaCy model on first use and fails outright without an active virtualenv.
- Prefs are written **write-then-rename**. Tabs save on every open and close, so a plain write
  leaves a window where a truncated file on disk resets every preference to its default.
