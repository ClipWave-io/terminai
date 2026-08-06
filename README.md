# Clipwave Term

A terminal that is easier on the eyes, and talks back.

- **Tabs are rows down the left**, not a strip across the top.
- **Rounded, low-contrast surfaces** — two palettes, neither of them white-on-black.
- **Spoken summaries.** When a Claude Code turn ends, the one-line `SPOKEN:` summary is
  synthesized and played in a dock at the bottom of the window.
- **A real terminal.** One PTY per tab running your login shell, so zsh, git, vim, ssh and
  Claude Code all behave exactly as they do anywhere else.

## Running it

```bash
npm install     # approves the native install scripts electron + node-pty need
npm run dev     # hot-reloading development window
npm run dist    # builds release/mac-arm64/Clipwave Term.app
```

The app is unsigned, so the first launch needs right-click → Open.

## How the voice part works

It reuses the setup already in `~/.claude` rather than replacing it:

| Piece | Owner | Role |
|---|---|---|
| `~/.claude/CLAUDE.md` | you | makes every response end with `SPOKEN: <one sentence>` |
| `~/.claude/speak-summary.sh` | you (a `Stop` hook) | writes that line to `~/.claude/spoken.txt` |
| `~/.claude/speak-file.sh` | you | speaks it on a global hotkey |
| **Clipwave Term** | this repo | watches `spoken.txt`, synthesizes, and plays it in-window |

Nothing here writes to `~/.claude`. The existing hotkey keeps working whether or not this app
is running, and the app keeps working if you delete the hotkey.

Two engines: macOS `say` by default (free, offline, instant) and ElevenLabs when
`ELEVENLABS_API_KEY` is in the environment and the toggle is on. ElevenLabs falls back to `say`
on any network failure, so a dead connection degrades the voice rather than losing the clip.

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
| `⇧⌘L` | switch Dusk ↔ Paper |
| `⇧⌘S` | play / replay the latest summary |
| `⌘+` / `⌘−` | font size |
| `⌘,` | settings |

Everything else falls through to the shell untouched, so Claude Code's own bindings still work.

## Layout

```
src/main/       PTY sessions, prefs, the spoken.txt watcher, TTS engines
src/preload/    the single contextBridge surface the renderer gets
src/renderer/   React UI: tab rail, terminal panes, voice dock, settings
src/shared/     types and the two palettes
```

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
- Prefs are written **write-then-rename**. Tabs save on every open and close, so a plain write
  leaves a window where a truncated file on disk resets every preference to its default.
