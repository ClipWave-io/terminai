# TerminAI setup

## Open the app

Open **TerminAI** in Applications. Existing terminal tabs and preferences keep their original app identity. Choose **Sign in to your workspace** during the welcome screen, or open **Team** from the toolbar later. **Continue locally** works without an account.

Workspace manager: https://terminai-manager-production.up.railway.app

The first company owner uses the private one-time setup link supplied on this computer and chooses their own password. After setup, use **Manage workspace** to create invitations. Send an invitation to each intended teammate; invitations expire after 48 hours. No invitation emails are sent automatically.

## Choose who can see work

The manager separates **role** (owner, admin, member, viewer) from **classification** (general, developer, analyst, marketing).

- Owners control company sharing policy and administrators.
- Administrators manage ordinary members, invitations, and MCP assignments.
- Members create and participate in conversations they can access.
- Viewers can read authorized conversations but cannot post.

Conversations default to **Only me**. To collaborate, create a company conversation and choose its allowed roles in the manager. Administrators do not gain access to someone else's private conversation. Disabling company sharing immediately makes existing shared conversations private.

In the desktop **Team** panel, select a conversation to read or write messages. To share an active terminal, explicitly enable its visible-output checkbox. Sharing runs only while that panel remains open; stop it before entering private information. Incoming messages are displayed as text and never executed in a terminal. This version does not automatically forward questions to an agent or run an AI model in the manager.

## Tools for your role

On sign-in, TerminAI fetches your current assignments and registers supported MCP servers with your installed Codex and Claude Code CLIs. Existing personal MCP settings are preserved. A pinned package downloads automatically when the agent first launches it. Restart your Codex or Claude Code session after setup so it reads the new configuration.

Default assignments:

| Tool | Default assignment | Local prerequisites |
| --- | --- | --- |
| Chrome DevTools | All roles | Codex or Claude Code, Node.js 22+, Google Chrome |
| Google Ads | Analyst and marketing classifications | Codex or Claude Code, Python/pipx, your own Google authorization and Google Cloud project |

The manager can change these assignments. Assignment controls provisioning; it does not erase or remotely disable tools that a person separately installed on their own computer. No Google credentials, browser profile, or personal Codex secrets are copied to other users.

Google Ads needs each user's own Application Default Credentials with the Google Ads scope, an enabled Google Ads API project, and a developer token where required. Follow the [official Google Ads MCP setup](https://github.com/googleads/google-ads-mcp#setup-instructions). TerminAI shows **needs setup** until the local prerequisites are present; registration alone does not prove account access.

## Files and browsing

**Files** opens a read-only project viewer. Choose a folder, then preview text and supported images. The arrow moves this pane to the other side of the terminal. On a narrow window, pane tabs replace the columns. The sidebar can still move independently.

**Browser** opens a separate Chromium browsing session. It cannot access the terminal's privileged APIs. **Open in Chrome** opens the current page in your installed Google Chrome. The embedded browser and Chrome DevTools MCP are separate sessions.

## Test with a second laptop

1. The owner creates a member invitation with the desired classification.
2. Your teammate installs the matching build for their operating system, accepts the invitation, and signs in to the same manager.
3. Confirm a private conversation is invisible to the other person.
4. Create a company conversation, exchange messages, and optionally enable visible terminal output.
5. Restrict the allowed roles or remove membership and confirm access disappears.

The current distributable targets Apple Silicon macOS. Windows, Linux, and Intel Mac builds require separate packaging and platform validation.

## Embedded browsing in Claude Code and Codex

TerminAI 0.2.7 registers `terminai_browser` for both clients. Launch or restart your agent inside a TerminAI terminal tab so it inherits that tab’s `TERMINAI_WORKSPACE_ID`. In Claude Code, use `/mcp` to inspect the connection. Each coding session sees only its own embedded browser tabs. Outside TerminAI, this server exposes no tools.

Registration preserves existing personal MCP definitions. A small `.claude.json.terminai-browser.json` sidecar records only the browser definition TerminAI created, allowing app-path updates without overwriting user edits. If you already have a different `terminai_browser` entry, TerminAI leaves it alone; inspect it before changing it. Claude’s entry is in `~/.claude.json` (or `.claude.json` inside `CLAUDE_CONFIG_DIR`), and Codex’s entry is in `$CODEX_HOME/config.toml`. Assigned team tools report their setup state separately for each client.

Apple Passwords, iCloud passkeys and Chrome profile import are planned features, not implemented by this release.
