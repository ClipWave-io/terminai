#!/usr/bin/python3
"""MacGuard: sorveglia memoria, swap, disco, CPU e GPU del Mac e ferma la crescita prima del blocco.

Perché esiste: il 21/10/2026 alle 16:41 il Mac si è bloccato con 18 sessioni Claude aperte. Il kernel ha loggato
"low swap: failed to create swapfile" (disco quasi pieno) e "memorystatus: System is unhealthy": la memoria
disponibile è crollata da 6,7 a 0,8 GB in 20 secondi e lo swap non poteva più crescere. Spento col tasto.

Comandi:
  macguard run [--home DIR]      ciclo di sorveglianza (lo lancia il LaunchAgent com.terminai.macguard, installato da install.sh)
  macguard status                stato attuale; exit 0 ok, 1 attenzione, 2 critico, 3 guardiano fermo
  macguard gate [N]              si possono aprire N sessioni nuove? exit 0 sì, 1 no (con i motivi)
  macguard resume [ID ...]       riprende le sessioni messe in pausa dal guardiano (senza ID tutte; ID = id della scheda TerminAI)
  macguard selftest              prove della logica su campioni finti (anche quelli del blocco del 21/10)

Soglie in config.json nella cartella del guardiano, rilette a ogni campione.
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

DEFAULT_HOME = os.path.expanduser("~/Library/Application Support/MacGuard")
# Solo per la via di riserva di tabs_state(); sotto launchd il PATH è minimo e di solito node non c'è.
NODE = shutil.which("node") or ""
TERMINAI = os.path.expanduser("~/Library/Application Support/clipwave-term/bin/terminai")
LEVELS = ["ok", "attenzione", "critico"]

DEFAULTS = {
    "interval_s": 5,
    "disk_warn_gb": 10, "disk_crit_gb": 4,
    # Il compressore è l'indicatore che anticipa: il 21/10 è salito da 6,3 a 12 GB prima del crollo.
    "compressor_warn_gb": 6.5, "compressor_crit_gb": 9.5,
    "memlevel_warn": 25, "memlevel_crit": 12,
    "swap_warn_gb": 6,
    "load_warn_per_cpu": 4.0, "load_warn_samples": 6,
    "gpu_warn_pct": 95, "gpu_warn_samples": 12,
    "down_samples": 6,
    "resume_ok_samples": 12,
    "pause_gap_s": 10,
    # 21/10 17:32: con "una pausa ogni 10 s finché critico" ha fermato 13 sessioni su 13 e congelato il terminale.
    # Dopo la prima pausa ne fa un'altra solo se la memoria continua a peggiorare, e mai più di max_paused.
    "max_paused": 3,
    # Una sessione ripresa a mano (pulsante Resume di TerminAI o macguard resume) non torna in pausa per questi secondi.
    # 10/11: erano 600. A livello critico con "Resume all" toglieva la protezione per 10 minuti; 2 bastano a non far sembrare rotto il pulsante.
    "resume_hold_s": 120,
    # Processi usa-e-getta che possono esplodere: chiusi oltre la soglia (GB) quando il livello non è ok.
    # claude-history: una ricerca lexical arriva a 8,7 GB di picco (misurato il 21/10).
    "kill_runaway_gb": {"claude-history": 3.0},
    "notify_gap_s": 600,
    "top_every_s": 30,
    "keep_log_days": 7,
    # 21/10: lavorare al limite. Il cancello ferma solo vicino al blocco; il freno vero resta il livello critico.
    "gate_disk_gb": 7, "gate_memlevel": 20, "gate_compressor_gb": 8, "gate_max_sessions": 17,
    # 10/11: il tetto di 17 sessioni si allenta (fino a gate_hard_max_sessions) SOLO a memoria chiaramente comoda:
    # libera almeno gate_count_memlevel e compressa non oltre gate_count_compressor_gb. Le soglie stanno sotto i valori
    # di prima del blocco del 21/10 (18 sessioni, compressa 6,3 GB): in quelle condizioni la diciannovesima resta NO.
    "gate_count_memlevel": 45, "gate_count_compressor_gb": 5.0, "gate_hard_max_sessions": 24,
    # Solo per le prove: si mettono in pausa soltanto le schede il cui nome inizia così.
    "pausable_prefix": "",
    "require_agent": True,
    "dry_run": False,
    "label": "",
}


def sh(args, timeout=8):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def config(home):
    c = dict(DEFAULTS)
    try:
        with open(os.path.join(home, "config.json")) as f:
            c.update(json.load(f))
    except (OSError, ValueError):
        pass
    return c


def sample():
    out = sh(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level", "kern.memorystatus_vm_pressure_level",
              "vm.loadavg", "vm.swapusage", "hw.ncpu"]).splitlines()
    sw = dict(re.findall(r"(\w+) = ([\d.]+)M", out[3]))
    vs = sh(["/usr/bin/vm_stat"])
    page = int(re.search(r"page size of (\d+)", vs).group(1))
    comp = int(re.search(r"occupied by compressor:\s+(\d+)", vs).group(1))
    st = os.statvfs("/System/Volumes/Data")
    gpu = re.search(r'"Device Utilization %"=(\d+)', sh(["/usr/sbin/ioreg", "-r", "-d", "1", "-c", "IOAccelerator"]))
    return {
        "mem_level": int(out[0]),
        "pressure": int(out[1]),
        "load1": float(out[2].strip("{} ").split()[0]),
        "swap_used_gb": float(sw["used"]) / 1024,
        "swap_total_gb": float(sw["total"]) / 1024,
        "ncpu": int(out[4]),
        "compressor_gb": comp * page / 2 ** 30,
        "disk_free_gb": st.f_bavail * st.f_frsize / 2 ** 30,
        "gpu_pct": int(gpu.group(1)) if gpu else -1,
    }


def classify(m, c, streak):
    crit, warn = [], []
    if m["disk_free_gb"] < c["disk_crit_gb"]:
        crit.append("disco libero %.1f GB: lo swap sta finendo lo spazio" % m["disk_free_gb"])
    elif m["disk_free_gb"] < c["disk_warn_gb"]:
        warn.append("disco libero %.1f GB" % m["disk_free_gb"])
    if m["pressure"] >= 4:
        crit.append("pressione memoria critica (kernel)")
    elif m["pressure"] >= 2:
        warn.append("pressione memoria in avviso (kernel)")
    if m["compressor_gb"] >= c["compressor_crit_gb"]:
        crit.append("memoria compressa %.1f GB" % m["compressor_gb"])
    elif m["compressor_gb"] >= c["compressor_warn_gb"]:
        warn.append("memoria compressa %.1f GB" % m["compressor_gb"])
    if m["mem_level"] <= c["memlevel_crit"]:
        crit.append("memoria libera %d%%" % m["mem_level"])
    elif m["mem_level"] <= c["memlevel_warn"]:
        warn.append("memoria libera %d%%" % m["mem_level"])
    if m["swap_used_gb"] >= c["swap_warn_gb"]:
        warn.append("swap %.1f GB" % m["swap_used_gb"])
    streak["load"] = streak.get("load", 0) + 1 if m["load1"] >= c["load_warn_per_cpu"] * m["ncpu"] else 0
    if streak["load"] >= c["load_warn_samples"]:
        warn.append("CPU: carico %.0f su %d core" % (m["load1"], m["ncpu"]))
    streak["gpu"] = streak.get("gpu", 0) + 1 if m["gpu_pct"] >= c["gpu_warn_pct"] else 0
    if streak["gpu"] >= c["gpu_warn_samples"]:
        warn.append("GPU al %d%%" % m["gpu_pct"])
    return (2 if crit else 1 if warn else 0), crit + warn


def memory_relaxed(m, c):
    """Condizione per riprendere le sessioni in pausa. Swap e carico restano alti a lungo dopo la crisi: non contano."""
    return (m["pressure"] < 2 and m["compressor_gb"] < c["compressor_warn_gb"] and m["mem_level"] > c["memlevel_warn"]
            and m["disk_free_gb"] >= c["disk_crit_gb"])


def worse(m, ref, c):
    """La memoria è peggiorata dall'ultima pausa? Se no, un'altra pausa non serve."""
    return (m["compressor_gb"] - ref["compressor_gb"] >= 0.5 or ref["disk_free_gb"] - m["disk_free_gb"] >= 0.5
            or ref["mem_level"] - m["mem_level"] >= 5)


def settle(level, raw, below, c):
    """Sale subito, scende di un gradino solo dopo down_samples campioni consecutivi più bassi."""
    if raw >= level:
        return raw, 0
    below += 1
    if below >= c["down_samples"]:
        return level - 1, 0
    return level, below


def gate_check(m, state_level, n_sessions, n_new, c):
    problems = []
    if state_level == 2:
        problems.append("il guardiano è a livello critico")
    if m["pressure"] >= 4:
        problems.append("pressione memoria critica (kernel)")
    if m["disk_free_gb"] < c["gate_disk_gb"]:
        problems.append("disco libero %.1f GB, servono almeno %d" % (m["disk_free_gb"], c["gate_disk_gb"]))
    if m["mem_level"] < c["gate_memlevel"]:
        problems.append("memoria libera %d%%, serve almeno %d%%" % (m["mem_level"], c["gate_memlevel"]))
    if m["compressor_gb"] > c["gate_compressor_gb"]:
        problems.append("memoria compressa %.1f GB, massimo %d" % (m["compressor_gb"], c["gate_compressor_gb"]))
    tight = m["mem_level"] < c["gate_count_memlevel"] or m["compressor_gb"] > c["gate_count_compressor_gb"]
    cap = c["gate_max_sessions"] if tight else c["gate_hard_max_sessions"]
    if n_sessions + n_new > cap:
        problems.append("%d sessioni aperte + %d nuove supera il tetto di %d%s" % (n_sessions, n_new, cap, " (memoria stretta)" if tight else ""))
    return problems


CONTROL = os.path.expanduser("~/Library/Application Support/clipwave-term/control.json")


def tabs_state():
    """(schede, motivo). Chiede l'elenco a TerminAI sul suo canale locale (control.json: porta e token), senza node:
    il percorso fisso di node v25.9.0 dava 0 schede in silenzio se node cambiava (10/11). motivo: "" se va tutto bene,
    "spento" se TerminAI non gira, altrimenti l'errore: in quel caso il guardiano è cieco e lo deve dire."""
    try:
        with open(CONTROL) as f:
            ctl = json.load(f)
    except (OSError, ValueError):
        return [], "spento"
    try:
        os.kill(int(ctl["pid"]), 0)
    except (OSError, KeyError, ValueError):
        return [], "spento"
    try:
        import urllib.request
        req = urllib.request.Request("http://127.0.0.1:%d/control" % int(ctl["port"]), data=json.dumps({"command": "list", "args": {}}).encode(),
                                     headers={"Authorization": "Bearer " + ctl["token"], "Content-Type": "application/json"}, method="POST")
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=8) as r:
            return json.loads(r.read().decode())["result"], ""
    except Exception as e:
        try:
            if NODE:
                return json.loads(sh([NODE, TERMINAI, "list"])), ""
        except ValueError:
            pass
        return [], "TerminAI non risponde (%s)" % type(e).__name__


def tabs():
    return tabs_state()[0]


UNITS = {"B": 1 / 1024, "K": 1, "M": 1024, "G": 1024 ** 2}
INTERPRETERS = re.compile(r"^(python[\d.]*|Python|node|bun|ruby|uv|uvx)$")


def footprints():
    """Memoria reale per pid in KB dalla colonna MEM di top: a differenza dell'RSS di ps conta anche la parte compressa."""
    mem = {}
    for line in sh(["/usr/bin/top", "-l", "1", "-stats", "pid,mem"]).splitlines():
        m = re.match(r"\s*(\d+)\s+([\d.]+)([BKMG])", line)
        if m:
            mem[int(m.group(1))] = float(m.group(2)) * UNITS[m.group(3)]
    return mem


def proc_table():
    """pid -> (ppid, memoria KB, stat, comm, etichetta leggibile)."""
    args = {}
    for line in sh(["/bin/ps", "-Axo", "pid=,args="]).splitlines():
        p = line.split(None, 1)
        if len(p) == 2:
            args[int(p[0])] = p[1]
    mem, rows = footprints(), {}
    for line in sh(["/bin/ps", "-Axo", "pid=,ppid=,rss=,stat=,comm="]).splitlines():
        p = line.split(None, 4)
        if len(p) == 5:
            pid, comm = int(p[0]), p[4]
            name = os.path.basename(comm)
            if INTERPRETERS.match(name):
                rest = [w for w in args.get(pid, "").split()[1:] if not w.startswith("-")]
                name = os.path.basename(rest[0]) if rest else name
            rows[pid] = (int(p[1]), mem.get(pid, int(p[2])), p[3], comm, name)
    return rows


def tree(root, rows):
    kids = {}
    for pid, r in rows.items():
        kids.setdefault(r[0], []).append(pid)
    out, stack = [], [root]
    while stack:
        p = stack.pop()
        if p in rows:
            out.append(p)
            stack.extend(kids.get(p, []))
    return out


def session_trees(rows, c):
    """Schede TerminAI con un agente vivo: nome, attiva, albero di processi, RSS totale."""
    res = []
    for t in tabs():
        if (c["require_agent"] and not (t.get("agent") or {}).get("alive")) or not t.get("pid"):
            continue
        pids = tree(t["pid"], rows)
        res.append({"id": t["id"], "name": t.get("name") or t.get("title", "")[:40], "active": t.get("active"),
                    "pids": pids, "rss_gb": sum(rows[p][1] for p in pids) / 2 ** 20})
    return res


def top_text(rows, n=3):
    big = sorted(rows.items(), key=lambda kv: -kv[1][1])[:n]
    return ", ".join("%s %.1f GB" % (r[4][:24], r[1] / 2 ** 20) for _, r in big)


def take_request(path):
    """Richiesta di ripresa: None se non c'è, altrimenti gli id da riprendere (vuota o "*" = tutte). Rinominata prima di
    leggerla: una richiesta aggiunta nel frattempo finisce in un file nuovo e non va persa."""
    taking = path + ".taking"
    try:
        os.replace(path, taking)
    except OSError:
        return None
    try:
        with open(taking) as f:
            ids = [l.strip() for l in f.read().splitlines() if l.strip()]
    except OSError:
        ids = []
    try:
        os.remove(taking)
    except OSError:
        pass
    return ids


def pick_resume(paused, ids):
    return list(paused) if not ids or "*" in ids else [s for s in paused if s["id"] in ids]


def pausable(sessions, paused, held, now, c):
    """Schede che si possono mettere in pausa: non quella aperta, non già in pausa, non riprese a mano da poco."""
    ids = [p["id"] for p in paused]
    return [s for s in sessions if not s["active"] and s["name"].startswith(c["pausable_prefix"]) and s["id"] not in ids
            and now - held.get(s["id"], 0) >= c["resume_hold_s"]]


# The Mac's notifications in English (12/11, Ilai): only what is shown is translated; the state file, the log and the
# events TerminAI's panel reads stay as they are.
EN = [
    (r"^Mac critico$", "Mac critical"), (r"^Mac attenzione$", "Mac warning"), (r"^Mac ok$", "Mac OK"),
    (r"Nessuna sessione da mettere in pausa\. Più pesanti: ", "No chat left to pause. Using most: "),
    (r"^Sessione in pausa: ", "Chat paused: "), (r"^Sessione ripresa: ", "Chat resumed: "),
    (r"Il Mac è tornato in condizioni normali\.", "The Mac is back to normal."),
    (r"Mac in stato critico: fermata per evitare il blocco\. Riparte da sola quando torna normale \(o: macguard resume\)\.",
     "The Mac is critical: paused so it does not freeze. It resumes by itself when the Mac is back to normal (or open it in TerminAI and press Resume)."),
    (r"^Chiuso (.+) da ([\d.]+) GB$", r"Closed \1 (\2 GB)"),
    (r"Ricerca nello storico fuori controllo, chiusa per proteggere il Mac\.", "A history search ran out of control and was closed to protect the Mac."),
    (r"^MacGuard non vede le schede$", "MacGuard cannot see the tabs"),
    (r"Non posso mettere in pausa nulla finché non le rivedo: ", "Nothing can be paused until it sees them again: "),
    (r"\. Più pesanti: ", ". Using most: "), (r"\. Non aprire altre sessioni\.", ". Do not open more chats."),
    (r"disco libero ([\d.]+) GB: lo swap sta finendo lo spazio", r"free disk \1 GB: swap is running out of space"),
    (r"disco libero ([\d.]+) GB", r"free disk \1 GB"),
    (r"pressione memoria critica \(kernel\)", "memory pressure critical (macOS)"),
    (r"pressione memoria in avviso \(kernel\)", "memory pressure warning (macOS)"),
    (r"memoria compressa ([\d.]+) GB", r"compressed memory \1 GB"), (r"memoria libera (\d+)%", r"free memory \1%"),
    (r"CPU: carico ([\d.]+) su (\d+) core", r"CPU load \1 on \2 cores"), (r"GPU al (\d+)%", r"GPU at \1%"),
]


def en(text):
    for pat, rep in EN:
        text = re.sub(pat, rep, text)
    return text


def terminai_shows():
    """TerminAI is running: it shows MacGuard's pauses and memory warnings itself, as TerminAI notifications with its icon."""
    try:
        with open(os.path.expanduser("~/Library/Application Support/clipwave-term/control.json")) as f:
            os.kill(int(json.load(f)["pid"]), 0)
        return True
    except Exception:
        return False


def notify(title, text, sound=None):
    """True se osascript ha accettato la notifica (non dice se macOS la mostra davvero)."""
    # 13/11 (Ilai): notifications from osascript show Script Editor's icon. With TerminAI open it shows them instead.
    if terminai_shows():
        return True
    title, text = en(title), en(text)
    # ensure_ascii=False: AppleScript non capisce gli escape \u00f9 (21/10: "Più pesanti" -> syntax error -2741).
    script = "display notification %s with title %s" % (json.dumps(text, ensure_ascii=False), json.dumps(title, ensure_ascii=False))
    if sound:
        script += ' sound name "%s"' % sound
    try:
        return subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, timeout=8).returncode == 0
    except Exception:
        return False


class Guard:
    def __init__(self, home):
        self.home = home
        os.makedirs(os.path.join(home, "log"), exist_ok=True)
        st = read_state(home) or {}
        self.paused = st.get("paused", [])
        self.held = {}
        self.last_blindcheck = 0.0
        self.level, self.below, self.ok_run = st.get("level", 0), 0, 0
        self.streak, self.last_notify, self.last_pause, self.last_top, self.last_tabcheck = {}, {}, 0.0, 0.0, 0.0
        self.day = ""
        # Riavviato con sessioni già in pausa: il riferimento è adesso, così non ne ferma altre se non peggiora.
        self.pause_ref = sample() if self.paused else None

    def log(self, name, line):
        day = time.strftime("%Y-%m-%d")
        with open(os.path.join(self.home, "log", "%s-%s.log" % (name, day)), "a") as f:
            f.write(time.strftime("%H:%M:%S ") + line + "\n")

    def event(self, text, c):
        self.log("eventi", ("[DRY] " if c["dry_run"] else "") + text)

    def say(self, key, title, text, c, sound=None, force=False):
        now = time.time()
        if not force and now - self.last_notify.get(key, 0) < c["notify_gap_s"]:
            return
        self.last_notify[key] = now
        sent = notify(c["label"] + title, text, sound)
        self.event("notifica%s: %s | %s" % ("" if sent else " NON INVIATA (osascript fallito)", title, text), c)

    def pause_one(self, c, rows):
        cands = pausable(session_trees(rows, c), self.paused, self.held, time.time(), c)
        if not cands:
            self.say("nopause", "Mac critico", "Nessuna sessione da mettere in pausa. Più pesanti: " + top_text(rows), c, "Sosumi")
            return
        s = max(cands, key=lambda x: x["rss_gb"])
        procs = [[p, rows[p][3]] for p in s["pids"]]
        if not c["dry_run"]:
            for p, _ in procs:
                try:
                    os.kill(p, signal.SIGSTOP)
                except OSError:
                    pass
        self.paused.append({"id": s["id"], "name": s["name"], "procs": procs, "at": time.strftime("%H:%M:%S")})
        self.last_pause = time.time()
        self.event("PAUSA %s (%d processi, %.1f GB)" % (s["name"], len(procs), s["rss_gb"]), c)
        self.say("pause-" + s["id"], "Sessione in pausa: " + s["name"],
                 "Mac in stato critico: fermata per evitare il blocco. Riparte da sola quando torna normale (o: macguard resume).",
                 c, "Sosumi", force=True)

    def kill_runaway(self, c):
        names = c["kill_runaway_gb"]
        pids = {}
        for line in sh(["/bin/ps", "-Axo", "pid=,comm="]).splitlines():
            p = line.split(None, 1)
            if len(p) == 2 and os.path.basename(p[1]) in names:
                pids[int(p[0])] = os.path.basename(p[1])
        if not pids:
            return False
        mem = footprints()
        killed = False
        for pid, name in pids.items():
            gb = mem.get(pid, 0) / 2 ** 20
            if gb >= names[name]:
                if not c["dry_run"]:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except OSError:
                        continue
                killed = True
                self.event("CHIUSO %s (pid %d, %.1f GB): ricerca fuori controllo" % (name, pid, gb), c)
                self.say("kill-" + name, "Chiuso %s da %.1f GB" % (name, gb),
                         "Ricerca nello storico fuori controllo, chiusa per proteggere il Mac.", c)
        return killed

    def reap_closed(self, c):
        """Scheda chiusa mentre era in pausa: i processi fermi non ricevono la chiusura finché non ripartono (21/10)."""
        ids = {t["id"] for t in tabs()}
        if not ids:
            return
        for s in [s for s in self.paused if s["id"] not in ids]:
            self.paused.remove(s)
            if not c["dry_run"]:
                for p, comm in reversed(s["procs"]):
                    for sig in (signal.SIGCONT, signal.SIGHUP):
                        try:
                            os.kill(p, sig)
                        except OSError:
                            pass
            self.event("scheda chiusa durante la pausa: %s, processi ripresi e chiusi" % s["name"], c)

    def resume_one(self, c, s=None):
        if s is None:
            s = self.paused.pop()
        else:
            self.paused.remove(s)
        if not c["dry_run"]:
            # Il comm protegge dai pid riusati nel frattempo da un altro processo.
            live = dict((int(l.split(None, 1)[0]), l.split(None, 1)[1]) for l in sh(["/bin/ps", "-Axo", "pid=,comm="]).splitlines()
                        if len(l.split(None, 1)) == 2)
            # Al contrario della pausa: prima i figli, la shell della scheda per ultima.
            for p, comm in reversed(s["procs"]):
                if live.get(p) == comm:
                    try:
                        os.kill(p, signal.SIGCONT)
                    except OSError:
                        pass
        self.event("RIPRESA %s" % s["name"], c)
        self.say("resume-" + s["id"], "Sessione ripresa: " + s["name"], "Il Mac è tornato in condizioni normali.", c, force=True)

    def step(self):
        c = config(self.home)
        m = sample()
        raw, reasons = classify(m, c, self.streak)
        new, self.below = settle(self.level, raw, self.below, c)
        rows = None
        if new != self.level:
            self.event("livello %s -> %s: %s" % (LEVELS[self.level], LEVELS[new], "; ".join(reasons) or "rientrato"), c)
            if new > self.level:
                rows = proc_table()
                text = "; ".join(reasons) + ". Più pesanti: " + top_text(rows) + ". Non aprire altre sessioni."
                self.say("lvl%d" % new, "Mac " + LEVELS[new], text, c, "Sosumi" if new == 2 else None, force=new == 2)
        self.level = new
        want = take_request(os.path.join(self.home, "resume.request"))
        if want is not None:
            for s in pick_resume(self.paused, want):
                self.resume_one(c, s)
                # Ripresa a mano: per resume_hold_s non la rimette in pausa, o il pulsante Resume sembrerebbe rotto.
                self.held[s["id"]] = time.time()
        killed = self.kill_runaway(c) if self.level >= 1 else False
        if self.level < 2:
            self.pause_ref = None
        elif (not killed and time.time() - self.last_pause >= c["pause_gap_s"] and len(self.paused) < c["max_paused"]
              and (self.pause_ref is None or worse(m, self.pause_ref, c))):
            self.pause_one(c, rows or proc_table())
            self.pause_ref = m
        self.ok_run = self.ok_run + 1 if self.level < 2 and memory_relaxed(m, c) else 0
        if time.time() - self.last_blindcheck >= 60:
            self.last_blindcheck = time.time()
            why = tabs_state()[1]
            if why and why != "spento":
                self.event("CIECO: non vedo le schede di TerminAI: %s" % why, c)
                self.say("blind", "MacGuard non vede le schede", "Non posso mettere in pausa nulla finché non le rivedo: %s." % why, c)
        if self.paused and time.time() - self.last_tabcheck >= 15:
            self.last_tabcheck = time.time()
            self.reap_closed(c)
        if self.paused and self.ok_run >= c["resume_ok_samples"]:
            self.resume_one(c)
            self.ok_run = 0
        self.write(m, reasons, c)
        return m

    def write(self, m, reasons, c):
        now = time.time()
        day = time.strftime("%Y-%m-%d")
        csv = os.path.join(self.home, "log", "campioni-%s.csv" % day)
        if not os.path.exists(csv):
            with open(csv, "w") as f:
                f.write("ora,livello,disco_gb,mem_libera_pct,pressione,compressa_gb,swap_gb,carico1,gpu_pct\n")
        with open(csv, "a") as f:
            f.write("%s,%s,%.2f,%d,%d,%.2f,%.2f,%.2f,%d\n" % (time.strftime("%H:%M:%S"), LEVELS[self.level], m["disk_free_gb"],
                    m["mem_level"], m["pressure"], m["compressor_gb"], m["swap_used_gb"], m["load1"], m["gpu_pct"]))
        if now - self.last_top >= c["top_every_s"]:
            self.last_top = now
            self.log("top", top_text(proc_table(), 6))
        state = {"epoch": now, "ora": time.strftime("%Y-%m-%d %H:%M:%S"), "level": self.level, "livello": LEVELS[self.level],
                 "motivi": reasons, "campione": {k: round(v, 2) if isinstance(v, float) else v for k, v in m.items()},
                 "paused": self.paused, "interval_s": c["interval_s"]}
        tmp = os.path.join(self.home, "state.json.tmp")
        with open(tmp, "w") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, os.path.join(self.home, "state.json"))
        if day != self.day:
            self.day = day
            cutoff = now - c["keep_log_days"] * 86400
            for n in os.listdir(os.path.join(self.home, "log")):
                p = os.path.join(self.home, "log", n)
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)

    def run(self):
        while True:
            try:
                self.step()
            except Exception as e:
                self.log("eventi", "errore: %r" % e)
            time.sleep(config(self.home)["interval_s"])


def read_state(home):
    try:
        with open(os.path.join(home, "state.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def fresh_state(home):
    st = read_state(home)
    if st and time.time() - st["epoch"] <= 3 * st.get("interval_s", 5) + 10:
        return st
    return None


def selftest():
    c = dict(DEFAULTS)
    base = {"mem_level": 39, "pressure": 1, "load1": 5.0, "swap_used_gb": 2.9, "swap_total_gb": 4, "ncpu": 8,
            "compressor_gb": 3.6, "disk_free_gb": 14.2, "gpu_pct": 16}
    cases = [
        ("normale di oggi dopo il riavvio", {}, 0),
        ("21/10 16:41:19, compressa 7,5 GB", {"compressor_gb": 7.46, "mem_level": 30}, 1),
        ("21/10 16:41:43, il crollo", {"compressor_gb": 11.9, "mem_level": 5, "pressure": 4, "disk_free_gb": 0.3}, 2),
        ("disco sotto 10 GB", {"disk_free_gb": 8}, 1),
        ("disco sotto 4 GB", {"disk_free_gb": 3}, 2),
        ("pressione kernel in avviso", {"pressure": 2}, 1),
    ]
    ok = True
    for name, delta, want in cases:
        got, why = classify(dict(base, **delta), c, {})
        ok &= got == want
        print("%s %-36s atteso %-10s ottenuto %-10s %s" % ("PASS" if got == want else "FAIL", name, LEVELS[want], LEVELS[got], "; ".join(why)))
    s = {}
    lv = [classify(dict(base, load1=40.0), c, s)[0] for _ in range(6)]
    want = [0, 0, 0, 0, 0, 1]
    ok &= lv == want
    print("%s carico CPU sostenuto: avviso solo al sesto campione %s" % ("PASS" if lv == want else "FAIL", lv))
    level, below, seq = 2, 0, []
    for _ in range(13):
        level, below = settle(level, 0, below, c)
        seq.append(level)
    want = [2] * 5 + [1] * 6 + [0] * 2
    ok &= seq == want
    print("%s isteresi da critico a ok: %s" % ("PASS" if seq == want else "FAIL", seq))
    rel = memory_relaxed(dict(base, swap_used_gb=6.8, load1=40.0), c), memory_relaxed(dict(base, compressor_gb=7), c)
    ok &= rel == (True, False)
    print("%s ripresa: swap 6,8 GB e carico alto non la bloccano, compressa 7 GB sì %s" % ("PASS" if rel == (True, False) else "FAIL", rel))
    ref = dict(base, compressor_gb=8.5, disk_free_gb=9.4, mem_level=30)
    wr = (worse(dict(ref, compressor_gb=8.6), ref, c), worse(dict(ref, disk_free_gb=8.8), ref, c), worse(dict(ref, compressor_gb=9.2), ref, c))
    ok &= wr == (False, True, True)
    print("%s nuova pausa solo se peggiora: stabile %s, disco -0,6 GB %s, compressa +0,7 GB %s" % ((("PASS" if wr == (False, True, True) else "FAIL"),) + wr))
    level, below = settle(0, 2, 0, c)
    ok &= level == 2
    print("%s salita immediata a critico" % ("PASS" if level == 2 else "FAIL"))
    tightm = dict(base, compressor_gb=7.0)
    g1 = gate_check(tightm, 1, 16, 1, c)
    g2 = gate_check(tightm, 0, 16, 2, c)
    g3 = gate_check(dict(base, disk_free_gb=6), 0, 2, 1, c)
    ok &= not g1 and len(g2) == 1 and len(g3) == 1
    print("%s cancello a memoria stretta: 16+1 passa %s | 16+2 no %s | disco 6 GB no %s" % ("PASS" if not g1 and g2 and g3 else "FAIL", g1, g2, g3))
    roomy = dict(base, mem_level=58, compressor_gb=3.9)
    g4, g5, g6 = gate_check(roomy, 1, 19, 1, c), gate_check(roomy, 0, 24, 1, c), gate_check(dict(roomy, mem_level=40), 0, 19, 1, c)
    ok &= not g4 and len(g5) == 1 and len(g6) == 1
    print("%s cancello a memoria comoda (libera 58%%, compressa 3,9 GB): 19+1 passa %s | 24+1 no %s | 19+1 con libera al 40%% no %s" % ("PASS" if not g4 and g5 and g6 else "FAIL", g4, g5, g6))
    g7 = gate_check(dict(base, compressor_gb=6.3), 0, 18, 1, c)
    ok &= len(g7) == 1
    print("%s cancello nelle condizioni di prima del blocco del 21/10 (18 sessioni, compressa 6,3 GB): la 19a è NO %s" % ("PASS" if g7 else "FAIL", g7))
    import tempfile
    req = os.path.join(tempfile.mkdtemp(), "resume.request")
    none = take_request(req)
    open(req, "w").close()
    every = take_request(req)
    for i in ("A", "B"):
        with open(req, "a") as f:
            f.write(i + "\n")
    two = take_request(req)
    P = [{"id": "A"}, {"id": "B"}, {"id": "C"}]
    got = (none, every, two, [s["id"] for s in pick_resume(P, two)], len(pick_resume(P, every)), len(pick_resume(P, ["*"])), os.path.exists(req))
    want = (None, [], ["A", "B"], ["A", "B"], 3, 3, False)
    ok &= got == want
    print("%s richiesta di ripresa: assente, tutte, solo A e B in append %s" % ("PASS" if got == want else "FAIL", got))
    now, S = 10000.0, [{"id": "A", "active": False, "name": "a"}, {"id": "B", "active": True, "name": "b"}, {"id": "C", "active": False, "name": "c"}]
    hold = ([s["id"] for s in pausable(S, [], {"C": now - 60}, now, c)], [s["id"] for s in pausable(S, [{"id": "A"}], {"C": now - 700}, now, c)])
    ok &= hold == (["A"], ["C"])
    print("%s pausa: mai la scheda aperta né una ripresa a mano entro resume_hold_s %s" % ("PASS" if hold == (["A"], ["C"]) else "FAIL", hold))
    return ok


def main(argv):
    home = DEFAULT_HOME
    if "--home" in argv:
        i = argv.index("--home")
        home = os.path.abspath(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd == "run":
        Guard(home).run()
    elif cmd == "selftest":
        sys.exit(0 if selftest() else 1)
    elif cmd == "status":
        st = fresh_state(home)
        if not st:
            print("Guardiano FERMO: nessuno stato recente in %s" % home)
            sys.exit(3)
        m = st["campione"]
        why = "; ".join(st["motivi"]) or ("in rientro, nessuna soglia superata adesso" if st["level"] else "")
        print("Livello: %s%s" % (st["livello"], " (%s)" % why if why else ""))
        print("Disco libero %.1f GB | memoria libera %d%% | compressa %.1f GB | swap %.1f GB | carico %.1f su %d core | GPU %d%%"
              % (m["disk_free_gb"], m["mem_level"], m["compressor_gb"], m["swap_used_gb"], m["load1"], m["ncpu"], m["gpu_pct"]))
        for p in st["paused"]:
            print("In pausa dalle %s: %s" % (p["at"], p["name"]))
        sys.exit(st["level"])
    elif cmd == "gate":
        n_new = int(argv[2]) if len(argv) > 2 else 1
        c = config(home)
        st = fresh_state(home)
        n = sum(1 for t in tabs() if (t.get("agent") or {}).get("alive"))
        problems = gate_check(sample(), st["level"] if st else 0, n, n_new, c)
        if not st:
            print("Avviso: guardiano fermo, controllo fatto solo sul campione di adesso")
        if problems:
            print("NO: non aprire %d sessioni nuove. %s" % (n_new, "; ".join(problems)))
            sys.exit(1)
        print("SÌ: %d sessioni aperte, se ne possono aggiungere %d" % (n, n_new))
    elif cmd == "resume":
        ids = [a for a in argv[2:] if a]
        st = fresh_state(home)
        if st:
            # Il ciclo in esecuzione tiene l'elenco delle pause: glielo chiedo e aspetto che lo svuoti.
            # Il ciclo prende la richiesta a inizio giro e scrive lo stato a fine giro: aspetto entrambe (23/10).
            # In append: due richieste ravvicinate (due Resume da TerminAI) non si sovrascrivono.
            t0 = time.time()
            with open(os.path.join(home, "resume.request"), "a") as f:
                f.write("\n".join(ids or ["*"]) + "\n")
            for _ in range(6 * st.get("interval_s", 5)):
                time.sleep(0.5)
                if (not os.path.exists(os.path.join(home, "resume.request"))
                        and (read_state(home) or {}).get("epoch", 0) > t0):
                    break
            # Nessun ciclo l'ha presa (guardiano fermo da pochi secondi, stato ancora "fresco"): la riprendo io (10/11).
            want = take_request(os.path.join(home, "resume.request"))
            if want is not None:
                g, c = Guard(home), config(home)
                for s in pick_resume(g.paused, want):
                    g.resume_one(c, s)
                g.write(sample(), [], c)
        else:
            g, c = Guard(home), config(home)
            for s in pick_resume(g.paused, ids):
                g.resume_one(c, s)
            g.write(sample(), [], c)
        print("Sessioni in pausa: %d" % len((read_state(home) or {}).get("paused", [])))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main(sys.argv)
