# TerminAI 0.2.7 candidate — September 30, 2026

## Recovered work

The installed and last packaged app was 0.2.6, dated September 23. Git main was `27fec69`, including PDF viewing, private browsing, toolbar configuration and workspace layout fixes. Both existing feature worktrees were older than main.

Claude session `d97d3d36-ede7-4aa5-9da3-7583e0bc2b34` contained an interrupted selection/cursor patch. A later request in that conversation asked for planning before installation. The source still had its uncommitted 50-line selection override. This candidate incorporates that work with modifier-click handling, cleanup, a pinned xterm dependency and a focused test. The original checkout and running app have not been changed.

The referenced Codex session `01a0c984-3587-7bc1-ad59-b1c4aad3318b` confirmed installation of 0.2.6. There was no newer packaged version in the inspected repository/worktrees. Other tasks in that mixed conversation were outside this review.

## Changes

- Arc-inspired public landing page with responsive cream/lavender styling, an illustrated workspace, Codex and Claude Code positioning, feature sections and explicit planned-feature labels.
- Separate public landing, team sign-in, first-owner setup and invitations. Owner setup now explains Railway → manager service → Variables → SETUP_TOKEN. Normal team members never enter this token.
- Owner setup is disabled when the token is absent/short or setup is already complete. Invalid tokens remain rejected. Private fragment links clear the token from the URL.
- Dashboard navigation for overview, team, tools, conversations and account; existing role restrictions and private-conversation rules preserved.
- Embedded browser MCP registration for Claude Code and Codex. Existing personal definitions are preserved. Company-assigned MCP setup supports either installed CLI and reports each client's result.
- Recovered terminal selection fix, without restarting any active terminal sessions.

## Validation and limits

TypeScript checking and the production renderer/main/preload build pass. Focused tests cover owner setup status/rejection, authentication security helpers, MCP allowlisting and both client registrations, malformed/conflicting user settings, and click/drag behavior. jsdom tests cover the public page, sign-in, setup retry/success, disabled setup, private links, invitations, dashboard sections and viewer restrictions. CSS parses successfully.

This session cannot bind local network ports or create PostgreSQL shared memory. Real database integration and end-to-end browser bridge tests therefore remain to be run in an unrestricted development session. Chrome DevTools interaction/screenshot tools also required unavailable approval, so no visual browser review is claimed. Claude/Codex live authenticated agent sessions have not been exercised.

The Mac artifact is an unsigned/unnotarized Apple Silicon beta, matching the existing project's packaging mode. It does not implement Apple Passwords, iCloud passkeys or Chrome profile import. These remain marked planned.

## Deployment handoff

This is a separate checkout, because the original `/Users/ilaibachrach/Clipwave/clipwave-term` is outside this session's writable area. It preserves the original uncommitted selection patch. Review this branch before integrating it; do not blindly overwrite that original file.

The manager is independently deployable from `manager/`. Railway CLI could not resolve its API in this restricted session. No Railway deployment, GitHub push, app installation or process restart was performed.

Before deployment, run `MANAGER_TEST_DATABASE_URL=postgresql://localhost/terminai_test_refresh npm test` inside `manager/`, using a disposable local database. Then deploy the manager directory to its existing Railway service using the existing project/service link and validate `/health`, landing, setup/login and invitations. Do not create a second owner or reset production data.

Open `manager/public/index.html` for a local design preview (team APIs require the server). The release CTA points to the project's release listing, not to an invented download. Update it to the verified signed release asset when one is published.
