# TerminAI: future work

Ideas Ilai asked for that are not built yet, newest first. Move an item into the To-do when someone picks it up.

## Team chat beside the To-do
A chat panel on the side of the To-do sheet (and in the iPhone app), slick and fast:
- text and pasted or dropped pictures
- `@Matteo` / `@Ilai` mentions that notify the other person (in TerminAI, top right, and on the phone)
- `#` to link a task: the message shows the task as a chip, a click opens it
- ask the other person for things ("can you check X?"), turn a message into a task
- the agents can post there too, signed as AI, like they are in Activity

## Realtime shared backend (Railway)
Shared tasks sync through the build-tasks git repo every 3 minutes, which is slow for notes and chat.
- A small Railway service (Node + Postgres) with a live connection (websocket), so edits, notes and chat appear at once on both Macs and the phone.
- Model it on how ManyMotions Spaces works: a Space with members, documents and comments, files stored in Postgres (bytea, deduplicated by sha256). Spaces polls over HTTP (1 s on an open page, 4 s otherwise); here push over a websocket instead, polling only as a fallback.
- Keep the git repo as the history and backup: the service writes a commit per change, so Activity and History keep working.
- Sign-in: one key per person (Ilai, Matteo) to start.
- Cost: Railway Hobby, around $5 a month plus usage. Needs Ilai's go-ahead on the Railway account.

## iPhone app
- Version 1 is in `mobile/ios` (TestFlight): reads and writes the build-tasks repo through the GitHub API.
- Later: switch it to the realtime backend, push notifications for tags and changes, the chat.

## Housekeeping
- Merge `livio/unified`, `feat/manager-design-claude` (v0.2.7) and `feat/hide-conversations` into `main`.
- Matteo installs the current build so his Mac shows tags, AI labels and the new agent rules.
- `tests/project-files.test.ts` still expects large text previews to fail; it predates "preview any file".
- `tests/editor-ui-smoke.cjs` needs the window to have keyboard focus: it fails while another TerminAI window is in front.
