# TerminAI To-do for iPhone

The shared To-do on the phone: the columns (you, Together, the other one, Unassigned), the product filter,
add / edit / tick / start tasks, @tags, the pictures under a note, and Activity with every change.

It reads and writes the `ClipWave-io/build-tasks` repo through the GitHub API (one GraphQL query to read,
one commit per change, signed `<you>: <verb> <title>` with a `Via: iPhone app` trailer), so TerminAI on both
Macs picks phone edits up at its next sync. Each person signs in with a GitHub token that can read and write
that repo; it stays in the iPhone's keychain. A realtime backend replaces this later (see `FUTURE.md`).

- Project: `project.yml` (XcodeGen; `TerminAITodo.xcodeproj` is generated from it and committed).
- Bundle id `com.clipwave.terminai.todo`, team `99PQ34696X`.
- TestFlight: bump `CURRENT_PROJECT_VERSION` in `project.yml`, then `ASC_ISSUER_ID=… ./release.sh`.
  The first upload needs the app record in App Store Connect (Xcode's Organizer → Distribute App creates it).
- Simulator with real data (debug builds only):
  `SIMCTL_CHILD_TERMINAI_GITHUB_TOKEN=$(gh auth token) xcrun simctl launch <device> com.clipwave.terminai.todo`
