// Codex 0.158+ keeps no per-thread lock under the TUI, so a tab's thread is read
// from the state db. Lifts the functions verbatim out of src/main/pty-recovered.js
// (node-pty is built for Electron's ABI, so the module itself cannot be loaded
// here) and runs them against a fixture db and real processes. No ~/.codex.
// The resume commands under test are the real ones, not the test build's echo.
delete process.env.TERMINAI_TEST_BUILD;
const node_child_process = require("child_process"), node_fs = require("fs"), node_path = require("path"), node_os = require("os");
const src = node_fs.readFileSync(node_path.join(__dirname, "../src/main/pty-recovered.js"), "utf8");
function grab(name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(src);
  if (!m) throw new Error("missing " + name);
  let depth = 0;
  for (let k = src.indexOf("{", src.indexOf(")", m.index)); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(m.index + 1, k + 1);
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => { const m = re.exec(src); if (!m) throw new Error("missing " + re); return m[0]; };

// ---- fixture: a CODEX_HOME with a state db and the rollouts it points at ----
const root = node_fs.mkdtempSync(node_path.join(node_os.tmpdir(), "terminai-codex-db-"));
const home = node_path.join(root, "codex-home"), day = node_path.join(home, "sessions/2026/10/20");
node_fs.mkdirSync(day, { recursive: true });
process.env.CODEX_HOME = home;
const T0 = Date.now() - 864e5;
const id = (n) => `01a00000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CLIP_OLD = id(1), CLIP = id(2), CLIP_SUB = id(3), CLIP_EXEC = id(4), CLIP_ARCH = id(5), DESK = id(6), BCN1 = id(7), BCN2 = id(8), NOFILE = id(9), QUOTE = id(10), TWO1 = id(11), TWO2 = id(12);
const SUB = `{"subagent":{"thread_spawn":{"parent_thread_id":"${CLIP}","depth":1}}}`;
// [id, cwd, source, archived, created (s after T0), updated (s after T0), rollout on disk]
const rows = [
  [CLIP_OLD, "/fx/clip", "vscode", 0, 0, 100, true],
  [CLIP, "/fx/clip", "vscode", 0, 600, 900, true],
  [CLIP_SUB, "/fx/clip", SUB, 0, 700, 950, true],
  [CLIP_EXEC, "/fx/clip", "exec", 0, 710, 960, true],
  [CLIP_ARCH, "/fx/clip", "vscode", 1, 720, 970, true],
  [DESK, "/fx/desk", "cli", 0, 50, 60, true],
  [BCN1, "/fx/bcn", "vscode", 0, 0, 200, true],
  [BCN2, "/fx/bcn", "vscode", 0, 100, 2000, true],
  [NOFILE, "/fx/nofile", "vscode", 0, 0, 10, false],
  [QUOTE, "/fx/it's here", "vscode", 0, 0, 10, true],
  [TWO1, "/fx/two", "vscode", 0, 0, 500, true],
  [TWO2, "/fx/two", "vscode", 0, 0, 400, true],
];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = ["create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, sandbox_policy text not null, approval_mode text not null, archived integer not null default 0, created_at_ms integer, updated_at_ms integer);"];
for (const [tid, cwd, source, archived, c, u, onDisk] of rows) {
  const rollout = node_path.join(day, `rollout-2026-10-20T10-00-00-${tid}.jsonl`);
  if (onDisk) node_fs.writeFileSync(rollout, "{}\n");
  const cms = T0 + c * 1e3, ums = T0 + u * 1e3;
  sql.push(`insert into threads values (${q(tid)}, ${q(rollout)}, ${Math.floor(cms / 1e3)}, ${Math.floor(ums / 1e3)}, ${q(source)}, 'openai', ${q(cwd)}, 't', 'x', 'x', ${archived}, ${cms}, ${ums});`);
}
node_child_process.execFileSync("/usr/bin/sqlite3", [node_path.join(home, "state_5.sqlite")], { input: sql.join("\n") });
const created = (tid) => T0 + rows.find((r) => r[0] === tid)[4] * 1e3;
const updated = (tid) => T0 + rows.find((r) => r[0] === tid)[5] * 1e3;

// ---- what the lifted functions expect around them ----
const sessions = new Map();
let prefsTabs = [];
const load = () => ({ tabs: prefsTabs });
let fg = {};
const typed = [];
let onWrite = () => {};
const foregroundProcess = (tid) => fg[tid] ?? "";
const write = (tid, data) => { typed.push(data); const s = sessions.get(tid); if (s) s.typedAt = Date.now(); onWrite(tid, data); };
const claudeSessionExists = () => false;
const shellAliases = async () => [];
const wrapperFunctionFor = async () => null;
const keepOptions = (_kind, args) => args;
const shellQuote = (s) => s;
const names = ["codexHome", "codexStateDb", "codexThreadExists", "sqlText", "codexThreadIds", "processStartMs", "codexThreadFromDb", "codexLatestThread", "retryWhileDraining", "isBareShell", "resumeCommandFor"];
eval(
  [/const UUID_RE = .*;\n/, /const CODEX_INTERACTIVE = .*;\n/, /const dealtCodexThreads = .*;\n/, /const DRAIN_RETRY_MAX = .*;\n/].map(line).join("") +
  names.map(grab).join("\n") +
  "\nglobalThis.T = { codexThreadFromDb, codexLatestThread, retryWhileDraining, processStartMs, resumeCommandFor, dealtCodexThreads };"
);
const T = globalThis.T;
const P = (fn, ...a) => new Promise((r) => fn(...a, r));
let fails = 0;
const eq = (label, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : " (want " + JSON.stringify(want) + ")"}`); };
const mk = (cwd, agent) => ({ cwd, exited: false, closing: false, agent: { kind: "codex", alive: true, sessionId: "", resolvedAt: 0, resolving: false, startedAt: 0, pid: 1, ...agent } });

(async () => {
  eq("U0 fixture db readable with -readonly", node_child_process.execFileSync("/usr/bin/sqlite3", ["-readonly", node_path.join(home, "state_5.sqlite"), "select count(*) from threads"], { encoding: "utf8" }).trim(), String(rows.length));
  // U1: a real process, timed from ps etime
  const ms = await P(T.processStartMs, process.pid);
  eq("U1a processStartMs(own pid) within 2.5 s of the real start", Math.abs(ms - (Date.now() - process.uptime() * 1e3)) < 2500, true);
  eq("U1b processStartMs(no such pid) -> 0", await P(T.processStartMs, 999999), 0);
  sessions.set("timed", mk("/fx/nowhere", { pid: process.pid }));
  await P(T.codexThreadFromDb, sessions.get("timed"));
  eq("U1c an untimed agent is timed from its pid on first look", Math.abs(sessions.get("timed").agent.startedAt - ms) < 1500, true);
  sessions.clear();
  // U2: fresh Codex, first thread born right after it; a later sub-agent, exec and archived thread are not its own
  sessions.set("a", mk("/fx/clip", { startedAt: created(CLIP) - 900 }));
  eq("U2 fresh Codex -> its own first thread, not the newer sub-agent/exec/archived", await P(T.codexThreadFromDb, sessions.get("a")), CLIP);
  // U3: two in the same folder: each keeps the thread born after its own start
  sessions.set("old", mk("/fx/clip", { pid: 2, startedAt: created(CLIP_OLD) - 1200 }));
  eq("U3a older sibling -> the thread from its own window", await P(T.codexThreadFromDb, sessions.get("old")), CLIP_OLD);
  eq("U3b newer sibling -> the newest thread", await P(T.codexThreadFromDb, sessions.get("a")), CLIP);
  sessions.set("untimed", mk("/fx/clip", { pid: 3, startedAt: 0 }));
  eq("U3c sibling not timed yet -> wait for the next sweep", await P(T.codexThreadFromDb, sessions.get("a")), "");
  sessions.clear();
  // U4: nothing born since it started
  sessions.set("r", mk("/fx/clip", { sessionId: CLIP_OLD, startedAt: Date.now() - 1000 }));
  eq("U4a resumed by id, no /new -> blank (argv id stays)", await P(T.codexThreadFromDb, sessions.get("r")), "");
  sessions.clear(); sessions.set("n", mk("/fx/clip", { startedAt: Date.now() - 1000 }));
  eq("U4b fresh and unused -> blank", await P(T.codexThreadFromDb, sessions.get("n")), "");
  sessions.clear(); sessions.set("p", mk("/fx/bcn", { startedAt: updated(BCN2) - 100e3 }));
  eq("U4c alone, picked by hand (codex resume) -> the thread touched since it started", await P(T.codexThreadFromDb, sessions.get("p")), BCN2);
  sessions.clear();
  // U5: restore of a tab saved without an id
  eq("U5a id-less tab -> latest interactive thread of the folder", await T.codexLatestThread("/fx/clip"), CLIP);
  eq("U5b second id-less tab, same folder -> the next one", await T.codexLatestThread("/fx/clip"), CLIP_OLD);
  eq("U5c third -> none left", await T.codexLatestThread("/fx/clip"), "");
  eq("U5d cli-sourced thread counts too", await T.codexLatestThread("/fx/desk"), DESK);
  prefsTabs = [{ agentSession: BCN2 }];
  eq("U5e thread named by a saved tab is not dealt again", await T.codexLatestThread("/fx/bcn"), BCN1);
  sessions.set("live", mk("/fx/two", { sessionId: TWO1 }));
  eq("U5f thread held by a live tab is not dealt", await T.codexLatestThread("/fx/two"), TWO2);
  sessions.clear();
  eq("U5g rollout missing on disk -> skipped", await T.codexLatestThread("/fx/nofile"), "");
  eq("U5h folder without threads", await T.codexLatestThread("/fx/none"), "");
  eq("U5i quote in the path is escaped, not broken", await T.codexLatestThread("/fx/it's here"), QUOTE);
  // U6: the cwd the renderer passes reaches the resume command
  T.dealtCodexThreads.clear(); prefsTabs = [];
  eq("U6a codex tab without id + cwd -> resume the folder's latest", await T.resumeCommandFor({ kind: "codex", sessionId: "", args: [], cwd: "/fx/two" }), `codex resume ${TWO1}`);
  eq("U6b codex tab with id -> that id, cwd ignored", await T.resumeCommandFor({ kind: "codex", sessionId: TWO2, args: [], cwd: "/fx/two" }), `codex resume ${TWO2}`);
  eq("U6c codex tab without id or cwd -> fresh codex", await T.resumeCommandFor({ kind: "codex", sessionId: "", args: [] }), "codex");
  eq("U6d claude tab untouched by cwd", await T.resumeCommandFor({ kind: "claude", sessionId: "", args: [], cwd: "/fx/two" }), "claude --continue");
  eq("U6e codex tab whose thread has no rollout -> fresh codex", await T.resumeCommandFor({ kind: "codex", sessionId: NOFILE, args: [] }), "codex");
  eq("U6f claude tab saved without launch flags -> the historical default", await T.resumeCommandFor({ kind: "claude", sessionId: "", cwd: "/fx/two" }), "claude --dangerously-skip-permissions --continue");
  const bare = node_path.join(root, "bare-home");
  node_fs.mkdirSync(node_path.join(bare, "thread-writer-locks"), { recursive: true });
  process.env.CODEX_HOME = bare;
  eq("U6g Codex home with no state db and no sessions -> the saved id stands", await T.resumeCommandFor({ kind: "codex", sessionId: NOFILE, args: [] }), `codex resume ${NOFILE}`);
  node_fs.mkdirSync(node_path.join(bare, "sessions"));
  eq("U6h sessions folder without the thread's rollout -> fresh codex", await T.resumeCommandFor({ kind: "codex", sessionId: NOFILE, args: [] }), "codex");
  process.env.CODEX_HOME = home;
  // U7: drain retry, clock and timers 200x faster
  const realNow = Date.now.bind(Date), realST = setTimeout, t0 = realNow();
  Date.now = () => t0 + (realNow() - t0) * 200;
  globalThis.setTimeout = (fn, ms) => realST(fn, ms / 200);
  const run = async (label, script, wantTyped) => {
    sessions.clear(); typed.length = 0;
    const s = { exited: false, closing: false, typedAt: 0, outCount: 1000, buf: "x".repeat(1000), agent: null };
    sessions.set("t", s); fg = { t: "codex" };
    let n = 0;
    const out = (text) => realST(() => { s.buf += text; s.outCount += text.length; }, 5);
    onWrite = () => script(++n, s, out);
    s.typedAt = Date.now();
    T.retryWhileDraining("t", "codex resume X", 0);
    script(0, s, out);
    await new Promise((r) => realST(r, 2500));
    eq(label, typed.length, wantTyped);
  };
  const DRAIN = "Error: ... thread/resume failed: Server is draining; retry after reconnecting (code -32600)\r\n";
  await run("U7a draining twice, then it starts -> typed again 2 times", (n, s, out) => {
    fg.t = "codex";
    if (n < 2) { out(DRAIN); realST(() => { fg.t = "zsh"; }, 15); } else s.agent = { alive: true };
  }, 2);
  await run("U7b exits at once for another reason -> never retyped", (n, s, out) => { out("Error: No saved session found\r\n"); realST(() => { fg.t = "zsh"; }, 15); }, 0);
  await run("U7c draining, but the user typed in the tab -> never retyped", (n, s, out) => {
    out(DRAIN); realST(() => { fg.t = "zsh"; s.typedAt = Date.now() + 1; }, 15);
  }, 0);
  await run("U7d starts fine -> never retyped", () => { fg.t = "codex"; }, 0);
  Date.now = realNow; globalThis.setTimeout = realST;
  node_fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
