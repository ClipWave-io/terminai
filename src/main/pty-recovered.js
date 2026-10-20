// Recovered from the user-provided TerminAI-2026-09-07 app archive.
// The archive was patched after compilation; this readable module preserves
// its PTY parser, deferred close, Claude/Codex identity and launcher recovery.
import * as electron from 'electron';
import * as node_path from 'node:path';
import * as node_fs from 'node:fs';
import * as node_os from 'node:os';
import * as node_crypto from 'node:crypto';
import * as node_child_process from 'node:child_process';
import * as pty__namespace from '@homebridge/node-pty-prebuilt-multiarch';
import { load } from './store';
const sessions = /* @__PURE__ */ new Map();
function safeSend(wc, channel, payload) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
function loginShell() {
  const s = process.env.SHELL;
  return s && node_fs.existsSync(s) ? s : "/bin/zsh";
}
const SHIM = `#!/bin/sh
# TerminAI: give this tab its own Claude session id, so reopening the app can
# resume this conversation and not some other tab's. Take ourselves off PATH
# first — we are the first entry, so \`claude\` below is the real one.
PATH=\${PATH#"$CLIPWAVE_SHIM":}
export PATH

# Resuming by id, or naming one yourself: that id *is* this tab's conversation
# from here on, so record it and get out of the way.
prev=
for arg in "$@"; do
  case $prev in
    -r|--resume|--session-id)
      case $arg in
        -*) ;;
        *) printf '%s\\n' "$arg" > "$CLIPWAVE_SESSION_FILE" ;;
      esac
      break ;;
  esac
  prev=$arg
done
case " $* " in
  *" -r "*|*" --resume "*|*" --session-id "*) exec claude "$@" ;;
esac

# \`--continue\` means "the newest conversation in this folder" — it never tells
# us which one that was, and a tab that only ever resumes would keep no id at
# all. Resolve it to a concrete id here so the tab has one to come back to.
case " $* " in
  *" -c "*|*" --continue "*)
    # printf, not \`pwd\`: the trailing newline would become a trailing dash and
    # the folder would never match.
    slug=$(printf '%s' "$PWD" | tr -c 'a-zA-Z0-9' '-')
    newest=$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$newest" ]; then
      id=$(basename "$newest" .jsonl)
      printf '%s\\n' "$id" > "$CLIPWAVE_SESSION_FILE"
      # Drop the flag we are replacing; everything else the user typed stays.
      rest=
      for arg in "$@"; do
        case $arg in
          -c|--continue) ;;
          *) rest="$rest \\"$arg\\"" ;;
        esac
      done
      eval "exec claude --resume \\"$id\\"$rest"
    fi
    exec claude "$@" ;;
esac

id=$(uuidgen)
printf '%s\\n' "$id" > "$CLIPWAVE_SESSION_FILE"
exec claude --session-id "$id" "$@"
`;
function shimDir() {
  return node_path.join(electron.app.getPath("userData"), "shim");
}
function sessionIdFile(tabId) {
  return node_path.join(electron.app.getPath("userData"), "sessions", `${tabId}.id`);
}
function pruneSessionIds() {
  const dir = node_path.join(electron.app.getPath("userData"), "sessions");
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1e3;
  try {
    for (const f of node_fs.readdirSync(dir, { withFileTypes: true })) {
      const path = node_path.join(dir, f.name);
      if (node_fs.statSync(path).mtimeMs < cutoff) node_fs.rmSync(path, { force: true });
    }
  } catch {
  }
}
let shimReady = false;
function ensureShim() {
  if (shimReady) return true;
  try {
    node_fs.mkdirSync(shimDir(), { recursive: true });
    node_fs.mkdirSync(node_path.join(electron.app.getPath("userData"), "sessions"), { recursive: true });
    node_fs.writeFileSync(node_path.join(shimDir(), "claude"), SHIM, { mode: 493 });
    shimReady = true;
    pruneSessionIds();
  } catch (err) {
    console.error("[pty] could not install claude shim:", err);
  }
  return shimReady;
}
function ptyEnv(tabId) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "clipwave-term";
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE" || key === "CLAUDE_PID") {
      delete env[key];
    }
  }
  // The local control channel of this very instance (src/main/control.ts), so
  // a session can drive its own app's tabs and never another copy's.
  env.TERMINAI_CONTROL = node_path.join(electron.app.getPath("userData"), "control.json");
  env.TERMINAI_TAB_ID = tabId;
  // The `terminai` CLI that index.ts copies out of the asar at startup.
  const cliDir = node_path.join(electron.app.getPath("userData"), "bin");
  env.TERMINAI_CLI = node_path.join(cliDir, "terminai");
  // The To-do files (src/main/todos.ts), for `terminai todo`; sessions only read them.
  env.TERMINAI_TASKS_DIR = node_path.join(electron.app.getPath("userData"), "build-tasks", "tasks");
  env.TERMINAI_TODO_PERSONAL = node_path.join(electron.app.getPath("userData"), "todos-personal.json");
  env.PATH = `${cliDir}:${env.PATH ?? ""}`;
  if (ensureShim()) {
    env.CLIPWAVE_SHIM = shimDir();
    env.CLIPWAVE_SESSION_FILE = sessionIdFile(tabId);
    env.PATH = `${shimDir()}:${env.PATH ?? ""}`;
  }
  return env;
}
function createSession(opts = {}) {
  const id = node_crypto.randomUUID();
  const cwd = opts.cwd && node_fs.existsSync(opts.cwd) ? opts.cwd : node_os.homedir();
  const proc = pty__namespace.spawn(loginShell(), ["-l"], {
    name: "xterm-256color",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd,
    env: { ...ptyEnv(id), TERMINAI_WORKSPACE_ID: typeof opts.browserKey === "string" ? opts.browserKey : id }
  });
  const session = {
    id,
    proc,
    cwd,
    exited: false,
    lastDataAt: Date.now(),
    belled: false,
    // Output before this instant is a repaint we asked for, not the agent working.
    quietUntil: 0,
    // True while a title string is still waiting for its terminator.
    oscOpen: false,
    sawClaude: false,
    spawnedAt: Date.now(),
    // Last keystroke, and how much the tab has printed in total: buf is a window.
    typedAt: 0,
    outCount: 0,
    // Whichever claude/codex the user launched in this tab, found by scanAgents().
    agent: null,
    // Set by closeSession(): the tab is gone but the process gets a grace
    // window so ⇧⌘T can bring it back intact.
    closing: false,
    closeTimer: null,
    // Bound by attach(), once the renderer has a terminal listening. Anything
    // the shell prints before then is held rather than dropped on the floor.
    wc: null,
    buf: "",
    pendingExit: null
  };
  sessions.set(id, session);
  startSessionSweep();
  proc.onData((data) => {
    const chunk = readChunk(session, data);
    if (chunk.painted && Date.now() >= session.quietUntil) session.lastDataAt = Date.now();
    if (chunk.bell) session.belled = true;
    session.buf = (session.buf + data).slice(-524288);
    session.outCount += data.length;
    if (!safeSend(session.wc, "pty:data", { id, data })) session.wc = null;
  });
  proc.onExit(({ exitCode }) => {
    session.exited = true;
    if (session.wc && safeSend(session.wc, "pty:exit", { id, exitCode })) {
      sessions.delete(id);
    } else {
      session.pendingExit = exitCode;
    }
  });
  return { id, cwd };
}
function list() {
  return [...sessions.values()].filter((s) => !s.closing).map((s) => ({ id: s.id, cwd: s.cwd, exited: s.exited }));
}
function attach(wc, id) {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.buf) safeSend(wc, "pty:data", { id, data: s.buf });
  s.wc = wc;
  if (s.pendingExit !== null) {
    safeSend(wc, "pty:exit", { id, exitCode: s.pendingExit });
    sessions.delete(id);
  }
  return true;
}
function detachAll() {
  for (const s of sessions.values()) s.wc = null;
}
// What the terminal emits by itself, never the user: focus in/out and the
// replies to a program's cursor/device queries.
const TERM_REPLY = /^(?:\x1b\[(?:I|O|\?[0-9;]*c|[0-9;]*[Rn]|>[0-9;]*m))+$/;
function write(id, data) {
  const s = sessions.get(id);
  if (!s) return;
  // Writing to a pty whose process is gone throws inside node-pty and takes the
  // whole app down with it (seen: SIGABRT in pty.node), losing every session.
  if (s.exited) return;
  if (TERM_REPLY.test(data)) {
    // The program redraws in answer to this; that is an echo, not new work.
    s.quietUntil = Date.now() + 1500;
  } else {
    s.belled = false;
  }
  // Keystrokes and pastes; what xterm answers on its own starts with ESC.
  if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) s.typedAt = Date.now();
  try { s.proc.write(data); } catch { s.exited = true; }
}
function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || s.exited) return;
  if (cols < 1 || rows < 1) return;
  // Selecting a tab fits the pane and the program repaints: same echo as above.
  s.quietUntil = Date.now() + 1500;
  try {
    s.proc.resize(cols, rows);
  } catch {
  }
}
function kill(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.closeTimer) clearTimeout(s.closeTimer);
  try {
    s.proc.kill();
  } catch {
  }
  sessions.delete(id);
}
const CLOSE_GRACE_MS = 6e4;
// Closing a tab hides it at once but keeps the process for a minute, so a
// regretted ⌘W can be undone with ⇧⌘T and nothing is lost.
function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.wc = null;
  s.closing = true;
  if (s.closeTimer) clearTimeout(s.closeTimer);
  s.closeTimer = setTimeout(() => kill(id), CLOSE_GRACE_MS);
}
function uncloseSession(id) {
  const s = sessions.get(id);
  if (!s || !s.closing) return null;
  clearTimeout(s.closeTimer);
  s.closeTimer = null;
  s.closing = false;
  if (s.exited) {
    sessions.delete(id);
    return null;
  }
  return { id: s.id, cwd: s.cwd };
}
function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}
// Splits a chunk into what the terminal shows and what only addresses the
// terminal itself (the title). Returns whether a real bell was rung, and
// whether anything was actually painted: a title rewrite alone is not work.
function readChunk(s, data) {
  let rest = data;
  let outside = "";
  if (s.oscOpen) {
    const end = rest.search(/\x07|\x1b\\/);
    if (end < 0) return { bell: false, painted: false };
    s.oscOpen = false;
    rest = rest.slice(end + (rest[end] === "\x1b" ? 2 : 1));
  }
  for (;;) {
    const start = rest.indexOf("\x1b]");
    if (start < 0) {
      outside += rest;
      break;
    }
    outside += rest.slice(0, start);
    const body = rest.slice(start + 2);
    const end = body.search(/\x07|\x1b\\/);
    if (end < 0) {
      s.oscOpen = true;
      break;
    }
    rest = body.slice(end + (body[end] === "\x1b" ? 2 : 1));
  }
  return { bell: outside.includes("\x07"), painted: outside.replace(/\x07/g, "").length > 0 };
}
function foregroundProcess(id) {
  const s = sessions.get(id);
  if (!s || s.exited) return "";
  try {
    return s.proc.process || "";
  } catch {
    return "";
  }
}
let sessionSweep = null;
function refreshCwds() {
  const live = [...sessions.values()].filter((s) => !s.exited && s.proc.pid);
  if (!live.length) return;
  const byPid = new Map(live.map((s) => [s.proc.pid, s]));
  node_child_process.execFile(
    "lsof",
    ["-a", "-w", "-d", "cwd", "-Fpn", "-p", [...byPid.keys()].join(",")],
    (_err, stdout) => {
      if (!stdout) return;
      let current;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          current = byPid.get(Number(line.slice(1)));
        } else if (line.startsWith("n") && current) {
          const path = line.slice(1);
          if (path && node_fs.existsSync(path)) current.cwd = path;
          current = void 0;
        }
      }
    }
  );
}
// ---------- claude / codex under a tab ----------
const AGENT_KINDS = /* @__PURE__ */ new Set(["claude", "codex"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}
function sessionIdFromArgs(kind, args) {
  for (let i = 0; i < args.length - 1; i++) {
    const a = args[i];
    const hit = kind === "codex" ? a === "resume" : a === "-r" || a === "--resume" || a === "--session-id";
    if (hit && UUID_RE.test(args[i + 1])) return args[i + 1];
  }
  return "";
}
// Claude Code registers every interactive process in ~/.claude/sessions/<pid>.json
// and rewrites it when /clear rotates the id. PIDs recycle, so trust the file
// only if it names the pid we asked about.
function claudeSessionForPid(pid) {
  try {
    const j = JSON.parse(node_fs.readFileSync(node_path.join(node_os.homedir(), ".claude", "sessions", `${pid}.json`), "utf8"));
    return j.pid === pid && typeof j.sessionId === "string" && UUID_RE.test(j.sessionId) ? j.sessionId : "";
  } catch {
    return "";
  }
}
function codexHome() { return process.env.CODEX_HOME || node_path.join(node_os.homedir(), ".codex"); }
function codexStateDb() {
  const root = codexHome();
  try {
    const names = node_fs.readdirSync(root).filter((f) => /^state_\d+\.sqlite$/.test(f)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    return names.length ? node_path.join(root, names[0]) : "";
  } catch {
    return "";
  }
}
// Codex holds an fd on ~/.codex/thread-writer-locks/<thread>.lock for every
// thread it is writing: the one the user talks to plus any sub-agents. The
// user's is the `cli`-sourced one; sub-agents carry a JSON source.
function codexThreadForPid(pid, cb) {
  node_child_process.execFile("lsof", ["-a", "-w", "-p", String(pid), "-Fn"], { maxBuffer: 4 << 20 }, (_err, stdout) => {
    const ids = [];
    for (const line of (stdout || "").split("\n")) {
      const m = /^n.*\/thread-writer-locks\/([0-9a-f-]{36})\.lock$/i.exec(line);
      if (m) ids.push(m[1]);
    }
    if (!ids.length) return cb("");
    if (ids.length === 1) return cb(ids[0]);
    const byBirth = () => {
      const dir = node_path.join(codexHome(), "thread-writer-locks");
      const born = (id) => {
        try {
          return node_fs.statSync(node_path.join(dir, `${id}.lock`)).birthtimeMs;
        } catch {
          return Infinity;
        }
      };
      cb([...ids].sort((a, b) => born(a) - born(b))[0]);
    };
    const db = codexStateDb();
    if (!db) return byBirth();
    const list = ids.map((id) => `'${id}'`).join(",");
    node_child_process.execFile(
      "/usr/bin/sqlite3",
      ["-readonly", db, `select id from threads where source='cli' and id in (${list}) order by updated_at desc limit 1`],
      { timeout: 5e3 },
      (err, out) => {
        const id = (out || "").trim();
        if (!err && UUID_RE.test(id)) cb(id);
        else byBirth();
      }
    );
  });
}
// A thread Codex never flushed (no turn completed before the process died)
// has a lock file and nothing else; `codex resume <id>` refuses it, so a tab
// like that is better off starting Codex fresh in the same folder.
function codexThreadExists(id) {
  const root = node_path.join(codexHome(), "sessions");
  const dirs = (p) => {
    try {
      return node_fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => node_path.join(p, e.name));
    } catch {
      return [];
    }
  };
  const onDisk = () => {
    for (const y of dirs(root)) for (const m of dirs(y)) for (const d of dirs(m)) {
      try {
        if (node_fs.readdirSync(d).some((f) => f.endsWith(`-${id}.jsonl`))) return true;
      } catch {
      }
    }
    return false;
  };
  return new Promise((resolve) => {
    const db = codexStateDb();
    if (!db) return resolve(onDisk());
    node_child_process.execFile(
      "/usr/bin/sqlite3",
      ["-readonly", db, `select rollout_path from threads where id='${id}' limit 1`],
      { timeout: 5e3 },
      (err, out) => {
        const p = (out || "").trim();
        resolve(!err && p && node_fs.existsSync(p) ? true : onDisk());
      }
    );
  });
}
// Codex 0.158+ runs every thread inside a shared app-server daemon: the TUI
// under the tab holds no lock and its threads are no longer `cli`-sourced, so
// the lock lookup above comes back empty. The state db still says which folder
// a thread lives in and when it was born.
const CODEX_INTERACTIVE = "source in ('cli','vscode') and archived=0";
function sqlText(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function codexThreadIds(sql, cb) {
  const db = codexStateDb();
  if (!db) return cb([]);
  node_child_process.execFile("/usr/bin/sqlite3", ["-readonly", db, sql], { timeout: 5e3 }, (err, out) => {
    cb(err ? [] : String(out || "").split("\n").map((l) => l.trim()).filter((l) => UUID_RE.test(l)));
  });
}
function processStartMs(pid, cb) {
  node_child_process.execFile("ps", ["-o", "etime=", "-p", String(pid)], (_err, out) => {
    const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(out || "").trim());
    if (!m) return cb(0);
    cb(Date.now() - (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1e3);
  });
}
// A thread belongs to the Codex that started most recently before it in that
// folder: its first thread, or a later /new. A Codex alone in its folder that
// made none (`codex resume`, picked by hand) owns the one touched since.
function codexThreadFromDb(s, cb) {
  const a = s.agent;
  if (!a.startedAt) {
    return processStartMs(a.pid, (ms) => {
      a.startedAt = ms;
      ms ? codexThreadFromDb(s, cb) : cb("");
    });
  }
  let next = Infinity;
  let alone = true;
  for (const o of sessions.values()) {
    const b = o.agent;
    if (o === s || o.exited || !b || b.kind !== "codex" || !b.alive || o.cwd !== s.cwd) continue;
    alone = false;
    // A sibling not timed yet could be the owner: decide on the next sweep.
    if (!b.startedAt) return cb("");
    if (b.startedAt > a.startedAt || (b.startedAt === a.startedAt && b.pid > a.pid)) next = Math.min(next, b.startedAt);
  }
  const folder = `cwd=${sqlText(s.cwd)} and ${CODEX_INTERACTIVE}`;
  // etime is whole seconds and the first thread is born a moment after the process.
  const until = next < Infinity ? ` and created_at_ms < ${next - 1500}` : "";
  codexThreadIds(`select id from threads where ${folder} and created_at_ms >= ${a.startedAt - 1500}${until} order by created_at_ms desc limit 1`, (ids) => {
    if (ids.length || a.sessionId || !alone) return cb(ids[0] || "");
    codexThreadIds(`select id from threads where ${folder} and updated_at_ms >= ${a.startedAt} order by updated_at_ms desc limit 1`, (touched) => cb(touched[0] || ""));
  });
}
// A tab saved while its Codex thread could not be read comes back on the
// folder's latest conversation, as a Claude tab does with --continue: one
// thread per tab, and never one that another tab already names.
const dealtCodexThreads = /* @__PURE__ */ new Set();
function codexLatestThread(cwd) {
  const taken = new Set(dealtCodexThreads);
  for (const t of load().tabs) if (t && typeof t.agentSession === "string") taken.add(t.agentSession);
  for (const s of sessions.values()) if (s.agent?.sessionId) taken.add(s.agent.sessionId);
  return new Promise((resolve) => {
    codexThreadIds(`select id from threads where cwd=${sqlText(cwd)} and ${CODEX_INTERACTIVE} order by updated_at_ms desc limit 20`, async (ids) => {
      for (const id of ids) {
        if (taken.has(id) || !await codexThreadExists(id)) continue;
        dealtCodexThreads.add(id);
        return resolve(id);
      }
      resolve("");
    });
  });
}
function resolveAgentSession(s) {
  const a = s.agent;
  if (a.kind === "claude") {
    const id = claudeSessionForPid(a.pid) || a.sessionId || claudeSessionOf(s.id);
    if (id) a.sessionId = id;
    return;
  }
  // lsof is not free: once a thread is known, look again every 30s so an
  // in-TUI /new or /resume is still picked up.
  if (a.resolving || Date.now() - a.resolvedAt < (a.sessionId ? 3e4 : 1e4)) return;
  a.resolving = true;
  const done = (id) => {
    a.resolving = false;
    a.resolvedAt = Date.now();
    if (id) a.sessionId = id;
  };
  codexThreadForPid(a.pid, (id) => id ? done(id) : codexThreadFromDb(s, done));
}
function scanAgents() {
  node_child_process.execFile("ps", ["-e", "-ww", "-o", "pid=,ppid=,args="], { maxBuffer: 16 << 20 }, (err, stdout) => {
    if (err) return;
    const children = /* @__PURE__ */ new Map();
    const argsOf = /* @__PURE__ */ new Map();
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const p = Number(m[1]);
      const parent = Number(m[2]);
      argsOf.set(p, m[3]);
      const arr = children.get(parent);
      if (arr) arr.push(p);
      else children.set(parent, [p]);
    }
    for (const s of sessions.values()) {
      if (s.exited) continue;
      // Breadth-first: the shallowest claude/codex under the tab's shell is the
      // one the user launched, not a helper one of them spawned.
      const queue = [s.proc.pid];
      let found = null;
      while (queue.length && !found) {
        const pid = queue.shift();
        const argv = splitArgs(argsOf.get(pid) ?? "");
        const kind = node_path.basename(argv[0] ?? "");
        if (AGENT_KINDS.has(kind)) found = { kind, pid, args: argv.slice(1) };
        else {
          const kids = children.get(pid);
          if (kids) queue.push(...kids);
        }
      }
      if (!found) {
        // Sticky on purpose: a tab that ran an agent is restored as that agent.
        if (s.agent) s.agent.alive = false;
        continue;
      }
      if (!s.agent || s.agent.pid !== found.pid) {
        s.agent = { kind: found.kind, pid: found.pid, args: found.args, sessionId: sessionIdFromArgs(found.kind, found.args), alive: true, resolvedAt: 0, resolving: false, startedAt: 0 };
      }
      s.agent.alive = true;
      if (found.kind === "claude") s.sawClaude = true;
      resolveAgentSession(s);
    }
  });
}
function agentOf(id) {
  const a = sessions.get(id)?.agent;
  return a ? { kind: a.kind, sessionId: a.sessionId, args: a.args, alive: a.alive } : { kind: "", sessionId: "", args: [], alive: false };
}
function sweep() {
  scanAgents();
  refreshCwds();
}
function startSessionSweep() {
  if (sessionSweep) return;
  sweep();
  sessionSweep = setInterval(sweep, 3e3);
}
function usedClaude(id) {
  return sessions.get(id)?.sawClaude ?? false;
}
function isBareShell(proc) {
  return proc === "" || /^-?(zsh|bash|sh|fish)$/.test(proc);
}
function statusOf(id) {
  const s = sessions.get(id);
  if (!s || s.exited) return "exited";
  // A wrapper script keeps bash in the foreground while the agent runs beneath
  // it: a live agent means the tab is not idle, whatever sits on top.
  if (isBareShell(foregroundProcess(id)) && !sessions.get(id)?.agent?.alive) return "ready";
  if (s.belled) return "waiting";
  return Date.now() - s.lastDataAt < 2500 ? "working" : "waiting";
}
function cwdOf(id) {
  return sessions.get(id)?.cwd ?? node_os.homedir();
}
function claudeSessionOf(id) {
  try {
    return node_fs.readFileSync(sessionIdFile(id), "utf8").trim();
  } catch {
    return "";
  }
}
function claudeSessionExists(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
  const root = node_path.join(node_os.homedir(), ".claude", "projects");
  try {
    for (const dir of node_fs.readdirSync(root)) {
      if (node_fs.existsSync(node_path.join(root, dir, `${sessionId}.jsonl`))) return true;
    }
  } catch {
  }
  return false;
}
function recentClaudeSessions(cwd, limit) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = node_path.join(node_os.homedir(), ".claude", "projects", slug);
  try {
    return node_fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({ id: f.slice(0, -6), at: node_fs.statSync(node_path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, limit).map((f) => f.id);
  } catch {
    return [];
  }
}
// Options that take a value in the next argv slot; anything else that does not
// start with "-" is positional (a prompt) and must not be replayed on resume.
const CLAUDE_VALUE_OPTS = /* @__PURE__ */ new Set([
  "--model", "--effort", "--permission-mode", "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config", "--settings", "--setting-sources", "--agent", "--agents", "--system-prompt", "--append-system-prompt", "--system-prompt-file", "--append-system-prompt-file", "--output-style", "--name", "--worktree", "-w", "--max-turns", "--max-budget-usd", "--betas", "--plugin-dir", "--fallback-model", "--input-format", "--output-format", "--json-schema", "--from-pr"
]);
const CODEX_VALUE_OPTS = /* @__PURE__ */ new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--enable", "--disable", "--add-dir", "-i", "--image", "--local-provider", "--oss-provider"]);
const CODEX_SUBCOMMANDS = /* @__PURE__ */ new Set(["resume", "fork", "exec", "e", "review", "login", "logout", "mcp", "app", "cloud", "apply", "a", "completion", "debug", "features", "sandbox", "help"]);
// POSIX-ish word splitting, enough for alias bodies: '…', "…" and backslashes.
function shellWords(text) {
  const out = [];
  let cur = "";
  let has = false;
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") {
      if (c === "'") q = "";
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = "";
      else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}
function shellQuote(s) {
  return /^[\w@%+=:,.\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
// The launch flags worth replaying: options (with their values), minus anything
// that picks a session — that part is decided at resume time.
function keepOptions(kind, args) {
  const valued = kind === "codex" ? CODEX_VALUE_OPTS : CLAUDE_VALUE_OPTS;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (kind === "codex" && (a === "resume" || a === "fork")) continue;
    if (kind === "codex" && CODEX_SUBCOMMANDS.has(a)) break;
    if (!a.startsWith("-")) continue;
    const picksSession = kind === "codex" ? a === "--last" : a === "-r" || a === "--resume" || a === "-c" || a === "--continue" || a === "--session-id" || a === "--fork-session";
    if (picksSession) {
      if (kind === "claude" && (a === "-r" || a === "--resume" || a === "--session-id") && args[i + 1] !== void 0 && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    out.push(a);
    if (valued.has(a) && !a.includes("=") && args[i + 1] !== void 0 && !args[i + 1].startsWith("-")) out.push(args[++i]);
  }
  return out;
}
let aliasesPromise = null;
// `alias` from an interactive login shell, so a tab launched through an alias
// (cc, cx, …) is resumed through the same alias — env prefix and all.
function shellAliases() {
  if (aliasesPromise) return aliasesPromise;
  aliasesPromise = new Promise((resolve) => {
    node_child_process.execFile(
      loginShell(),
      ["-ilc", "alias"],
      { env: { ...process.env, TERM: "dumb" }, timeout: 15e3, maxBuffer: 4 << 20 },
      (_err, stdout) => {
        const out = /* @__PURE__ */ new Map();
        for (const line of String(stdout || "").split("\n")) {
          const m = /^(?:alias )?([A-Za-z_][\w.-]*)=(.*)$/.exec(line);
          if (!m) continue;
          const words = shellWords(m[2]);
          // zsh prints the body as one quoted string: open it, then split for real.
          const body = words.length === 1 && /^['"]/.test(m[2]) ? shellWords(words[0]) : words;
          while (body.length && /^[A-Za-z_]\w*=/.test(body[0])) body.shift();
          if (body.length) out.set(m[1], body);
        }
        resolve(out);
      }
    );
  });
  return aliasesPromise;
}
let wrappersPromise = null;
// `NAME="${ENV:-default}"` or plain `NAME=value` in the same body resolves a
// variable to its default, for the command word ("$CLAUDE_BIN") as well as
// for option values ("$MODEL").
function shellDefault(lines, name) {
  const env = new RegExp("(?:^|\\s)" + name + '="?\\$\\{[A-Za-z_]\\w*:-([^}"]*)\\}');
  const lit = new RegExp("(?:^|\\s)" + name + '=("?)([^"$\\s]+)\\1(?:\\s|$)');
  for (const l of lines) {
    const m = env.exec(l) || lit.exec(l);
    if (m) return m[m.length - 1];
  }
  return null;
}
// The claude/codex command line of a wrapper (shell function or script):
// which valued options it fixes, with literal values or the variable's default,
// and whether it forwards "$@" so a session flag can be appended.
function parseWrapper(rawLines) {
  const lines = [];
  let acc = "";
  for (const l of rawLines) {
    if (/\\$/.test(l)) {
      acc += l.slice(0, -1) + " ";
      continue;
    }
    lines.push(acc + l);
    acc = "";
  }
  const varName = (w) => /^"?\$\{?([A-Za-z_]\w*)\}?"?$/.exec(w)?.[1] ?? null;
  for (const line of lines) {
    const m = /^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:exec\s+)?(?:command\s+)?("?\$\{?[A-Za-z_]\w*\}?"?|claude|codex)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmdVar = varName(m[1]);
    const cmd = cmdVar ? shellDefault(lines, cmdVar) : m[1];
    const kind = cmd ? node_path.basename(cmd) : "";
    if (kind !== "claude" && kind !== "codex") continue;
    const valued = kind === "codex" ? CODEX_VALUE_OPTS : CLAUDE_VALUE_OPTS;
    const words = shellWords(m[2]);
    const opts = /* @__PURE__ */ new Map();
    let forwards = false;
    let picksSession = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === "$@") {
        forwards = true;
        continue;
      }
      if (!w.startsWith("-")) continue;
      if (w === "-r" || w === "--resume" || w === "-c" || w === "--continue" || w === "--session-id") picksSession = true;
      let value = null;
      let fallback = null;
      if (valued.has(w) && words[i + 1] !== void 0 && !words[i + 1].startsWith("-")) {
        value = words[++i];
        // "$MODEL" resolves to its default; "$FB,$MODEL" is just "some variable".
        if (value.includes("$")) {
          const v = varName(value);
          fallback = v ? shellDefault(lines, v) : null;
          value = null;
        }
      }
      opts.set(w, { value, fallback });
    }
    return forwards && !picksSession ? { kind, opts } : null;
  }
  return null;
}
// Wrappers the user launches agents through: scripts in the user's bin folders
// and functions of the login shell (a function of the same name wins, as it
// does in the shell).
function shellWrappers() {
  if (wrappersPromise) return wrappersPromise;
  wrappersPromise = new Promise((resolve) => {
    node_child_process.execFile(
      loginShell(),
      ["-ilc", "functions"],
      { env: { ...process.env, TERM: "dumb" }, timeout: 15e3, maxBuffer: 16 << 20 },
      (_err, stdout) => {
        const out = /* @__PURE__ */ new Map();
        for (const dir of [node_path.join(node_os.homedir(), ".local", "bin"), node_path.join(node_os.homedir(), "bin")]) {
          let names = [];
          try {
            names = node_fs.readdirSync(dir);
          } catch {
            continue;
          }
          for (const n of names) {
            try {
              const p = node_path.join(dir, n);
              const st = node_fs.statSync(p);
              if (!st.isFile() || st.size > 262144) continue;
              const text = node_fs.readFileSync(p, "utf8");
              if (!text.startsWith("#!")) continue;
              const w = parseWrapper(text.split("\n"));
              if (w) out.set(n, w);
            } catch {
            }
          }
        }
        const bodies = /* @__PURE__ */ new Map();
        let name = "";
        for (const line of String(stdout || "").split("\n")) {
          const head = /^([A-Za-z_][\w.-]*) \(\) \{/.exec(line);
          if (head) {
            name = head[1];
            bodies.set(name, []);
            continue;
          }
          if (name) bodies.get(name).push(line);
        }
        for (const [fn, lines] of bodies) {
          const w = parseWrapper(lines);
          if (w) out.set(fn, w);
        }
        resolve(out);
      }
    );
  });
  return wrappersPromise;
}
// Picks the wrapper for a process from its argv. A valued option (--model)
// with a literal value must match exactly; a variable value matches anything
// and scores higher when the process ran with the variable's default; flags
// alone prove nothing; a tie between wrappers is left unresolved.
async function wrapperFunctionFor(kind, args) {
  const valued = kind === "codex" ? CODEX_VALUE_OPTS : CLAUDE_VALUE_OPTS;
  let best = null;
  let tie = false;
  for (const [name, f] of await shellWrappers()) {
    if (f.kind !== kind) continue;
    let score = 0;
    let clash = false;
    for (const [opt, { value, fallback }] of f.opts) {
      if (!valued.has(opt)) continue;
      const i = args.indexOf(opt);
      if (i < 0) continue;
      const got = args[i + 1];
      if (value !== null) {
        if (got !== value) {
          clash = true;
          break;
        }
        score += 2;
      } else score += fallback !== null && got === fallback ? 2 : 1;
    }
    if (clash || !score) continue;
    if (!best || score > best.score) {
      best = { name, f, score };
      tie = false;
    } else if (score === best.score) tie = true;
  }
  if (!best || tie) return null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const hasValue = valued.has(a) && args[i + 1] !== void 0 && !args[i + 1].startsWith("-");
    if (!best.f.opts.has(a)) {
      rest.push(a);
      if (hasValue) rest.push(args[i + 1]);
    }
    if (hasValue) i++;
  }
  return { name: best.name, rest };
}
async function resumeCommandFor(d) {
  const kind = d.kind === "codex" ? "codex" : "claude";
  // Tabs saved before launch flags were recorded get the historical default.
  const args = Array.isArray(d.args) ? keepOptions(kind, d.args) : [];
  let best = null;
  for (const [name, words] of await shellAliases()) {
    if (node_path.basename(words[0]) !== kind) continue;
    const a = keepOptions(kind, words.slice(1));
    if (!a.length || a.length > args.length || a.some((w, i) => w !== args[i])) continue;
    if (!best || a.length > best.a.length) best = { name, a };
  }
  const wrapper = best ? null : await wrapperFunctionFor(kind, args);
  const head = best ? best.name : wrapper ? wrapper.name : kind;
  const rest = best ? args.slice(best.a.length) : wrapper ? wrapper.rest : args;
  let id = typeof d.sessionId === "string" && UUID_RE.test(d.sessionId) ? d.sessionId : "";
  if (kind === "codex" && !id && typeof d.cwd === "string" && d.cwd) id = await codexLatestThread(d.cwd);
  const tail = kind === "claude" ? id && claudeSessionExists(id) ? ["--resume", id] : ["--continue"] : id ? ["resume", id] : [];
  const command = [head, ...rest.map(shellQuote), ...tail].join(" ");
  // A test build runs beside the real app and must never resume the real conversations.
  if (process.env.TERMINAI_TEST_BUILD && !process.env.TERMINAI_TEST_ALLOW_AGENTS) return `echo ${shellQuote(`[test build] resume skipped: ${command}`)}`;
  return command;
}
// A Codex daemon that is restarting refuses clients until its running turns
// are over ("Server is draining"), which can be many minutes: the resume typed
// at launch dies at once and the tab is left on a bare prompt. Type it again
// for as long as that is the error on screen and nobody has touched the tab.
const DRAIN_RETRY_MAX = 45;
function retryWhileDraining(id, cmd, attempt) {
  const first = sessions.get(id);
  if (!first) return;
  const typedAt = Date.now();
  const mark = first.outCount;
  const poll = () => {
    const s = sessions.get(id);
    if (!s || s.exited || s.closing || s.typedAt > typedAt) return;
    const age = Date.now() - typedAt;
    if (age < 4e3 || !isBareShell(foregroundProcess(id))) {
      // Still running after half a minute: it started fine.
      if (age < 3e4) setTimeout(poll, 1e3);
      return;
    }
    const printed = s.outCount - mark;
    if (attempt >= DRAIN_RETRY_MAX || printed <= 0 || !s.buf.slice(-printed).includes("Server is draining")) return;
    setTimeout(() => {
      const t = sessions.get(id);
      if (!t || t.exited || t.closing || t.typedAt > typedAt || t.agent?.alive || !isBareShell(foregroundProcess(id))) return;
      write(id, `${cmd}\r`);
      retryWhileDraining(id, cmd, attempt + 1);
    }, Math.min(6e4, 15e3 * 2 ** attempt));
  };
  setTimeout(poll, 1e3);
}
// Type a command once the shell is sitting at a prompt (or after 10s regardless).
function execWhenReady(id, cmd) {
  const started = Date.now();
  const tick = () => {
    const s = sessions.get(id);
    if (!s || s.exited) return;
    const settled = Date.now() - s.spawnedAt >= 900 && isBareShell(foregroundProcess(id));
    if (settled || Date.now() - started > 1e4) {
      write(id, `${cmd}\r`);
      retryWhileDraining(id, cmd, 0);
      return;
    }
    setTimeout(tick, 200);
  };
  tick();
}
function liveIds() {
  return [...sessions.values()].filter((s) => !s.closing).map((s) => s.id);
}
function pidOf(id) {
  return sessions.get(id)?.proc.pid ?? 0;
}
function sizeOf(id) {
  const s = sessions.get(id);
  return s && !s.exited ? { cols: s.proc.cols, rows: s.proc.rows } : null;
}
// Raw output as the program wrote it, escape codes included: the last 512 KB.
function bufferOf(id) {
  return sessions.get(id)?.buf ?? "";
}

export { createSession, list, attach, detachAll, write, resize, kill, closeSession, uncloseSession, killAll, foregroundProcess, usedClaude, statusOf, cwdOf, claudeSessionOf, claudeSessionExists, recentClaudeSessions, liveIds, agentOf, resumeCommandFor, execWhenReady, pidOf, sizeOf, bufferOf };
