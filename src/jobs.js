// ─── jobs.js: the at/cron job scheduler ─────────────────────────
//
// Shared by the CLI shell (src/tinysh.js) and the browser shell
// (www/index.html). Each shell creates one scheduler (attached to
// shellApi.jobs for /bin/at.js and /bin/cron.js) and calls restore()
// at boot so persisted cron jobs survive reloads.
//
//   at     one-shot jobs via setTimeout (session-only, like real at)
//   cron   periodic jobs on a 30s tick, persisted to storagePath
//          (default /home/.tinyshcron) so they survive reloads
//
// Jobs run through the shell's runLine hook (runNestedCommand), so
// builtins, .js commands and wasm binaries all work; their stdout and
// stderr are written to the terminal when the job fires.
// -----------------------------------------------------------------

export function createJobScheduler({ fs, runLine, stdout, stderr, storagePath }) {
  const jobs = [];      // { id, type: "at"|"cron", cmd, ... }
  let seq = 1;
  let tick = null;
  let restored = false;

  // ─── cron schedule: "min hour dom mon dow" ──────────────────
  // Each field: * | */N | N-M | A,B | N. dow: 0 or 7 = Sunday.
  // Returns a matcher(Date) -> bool, or null if the schedule is bad.
  function parseCron(str) {
    const fields = String(str || "").trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const sets = [];
    for (let f = 0; f < 5; f++) {
      const [lo, hi] = ranges[f];
      const values = new Set();
      let ok = true;
      for (const part of fields[f].split(",")) {
        let m;
        if (part === "*") {
          for (let v = lo; v <= hi; v++) values.add(v);
        } else if ((m = /^\*\/(\d+)$/.exec(part))) {
          const step = parseInt(m[1], 10);
          if (step < 1) { ok = false; break; }
          for (let v = lo; v <= hi; v += step) values.add(v);
        } else if ((m = /^(\d+)-(\d+)$/.exec(part))) {
          const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
          if (a > b || a < lo || b > hi) { ok = false; break; }
          for (let v = a; v <= b; v++) values.add(v);
        } else if (/^\d+$/.test(part)) {
          const v = parseInt(part, 10);
          if (v < lo || v > hi) { ok = false; break; }
          values.add(v);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok || values.size === 0) return null;
      sets.push(values);
    }
    if (sets[4].has(7)) sets[4].add(0);   // Sunday == 7 == 0
    return function matches(now) {
      return sets[0].has(now.getMinutes()) &&
             sets[1].has(now.getHours()) &&
             sets[2].has(now.getDate()) &&
             sets[3].has(now.getMonth() + 1) &&
             sets[4].has(now.getDay());
    };
  }

  // Next minute at/after `from` matching `matcher`, or null.
  function nextMatch(matcher, from) {
    const d = new Date(from.getTime());
    d.setSeconds(0, 0);
    for (let i = 0; i < 525600; i++) {   // up to a year of minutes
      if (matcher(d)) return d.getTime();
      d.setMinutes(d.getMinutes() + 1);
    }
    return null;
  }

  // ─── at time: now | +Ns | +Nm | +Nh | +Nd | HH:MM ────────────
  function parseAt(str) {
    const s = String(str || "").trim().toLowerCase();
    const now = new Date();
    if (s === "now") return now;
    let m;
    if ((m = /^\+(\d+)([smhd])$/.exec(s))) {
      const n = parseInt(m[1], 10);
      const mul = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
      return new Date(now.getTime() + n * mul);
    }
    if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
      const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (hh > 23 || mm > 59) return null;
      const due = new Date(now);
      due.setHours(hh, mm, 0, 0);
      if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
      return due;
    }
    return null;
  }

  // ─── run a job ───────────────────────────────────────────────
  function fire(job) {
    Promise.resolve(runLine(job.cmd)).then((res) => {
      if (res && res.out && stdout && stdout.write) stdout.write(res.out);
      if (res && res.err && stderr && stderr.write) stderr.write(res.err);
      if (job.type === "at") remove(job.id);
    }).catch((e) => {
      if (stderr && stderr.write) {
        stderr.write(`job ${job.id}: ${(e && e.message) ? e.message : String(e)}\n`);
      }
    });
  }

  function remove(id) {
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    const job = jobs[idx];
    if (job._timer) clearTimeout(job._timer);
    jobs.splice(idx, 1);
    if (job.type === "cron") persist();
    return true;
  }

  function clear() {
    for (const j of jobs) if (j._timer) clearTimeout(j._timer);
    jobs.length = 0;
    persist();
  }

  // ─── persistence (cron only; at is session-scoped) ──────────
  function persist() {
    if (!fs || !storagePath) return;
    const cron = jobs
      .filter((j) => j.type === "cron")
      .map((j) => ({ id: j.id, schedule: j.schedule, cmd: j.cmd }));
    Promise.resolve(fs.write(storagePath, JSON.stringify(cron))).catch(() => {});
  }

  async function restore() {
    startTick();
    if (restored || !fs || !storagePath) return;
    restored = true;
    try {
      const raw = await fs.read(storagePath);
      const saved = JSON.parse(raw);
      for (const item of saved || []) {
        const matcher = parseCron(item.schedule);
        if (!matcher) continue;
        const next = nextMatch(matcher, new Date());
        if (next === null) continue;
        let id = item.id;
        if (!id || jobs.some((j) => j.id === id)) id = "c" + seq++;
        jobs.push({ id, type: "cron", schedule: item.schedule, cmd: item.cmd, matcher, nextRun: next });
      }
    } catch (e) {
      // no jobs file yet — that's fine
    }
  }

  function startTick() {
    if (tick || typeof setInterval === "undefined") return;
    tick = setInterval(() => {
      const now = Date.now();
      for (const job of jobs) {
        if (job.type === "cron" && job.nextRun && job.nextRun <= now) {
          job.nextRun = nextMatch(job.matcher, new Date(now + 60000));
          if (job.nextRun !== null) fire(job);
        }
      }
    }, 30000);
  }

  return { addAt, addCron, list, remove, clear, restore, startTick };

  // ─── public API ──────────────────────────────────────────────
  function addAt(whenStr, cmd) {
    const due = parseAt(whenStr);
    if (!due) return { error: "bad time" };
    const job = { id: "a" + seq++, type: "at", cmd, when: whenStr, nextRun: due.getTime() };
    jobs.push(job);
    job._timer = setTimeout(() => fire(job), Math.max(0, due.getTime() - Date.now()));
    return job;
  }

  function addCron(schedule, cmd) {
    const matcher = parseCron(schedule);
    if (!matcher) return { error: "bad schedule" };
    const next = nextMatch(matcher, new Date());
    if (next === null) return { error: "never matches" };
    const job = { id: "c" + seq++, type: "cron", schedule, cmd, matcher, nextRun: next };
    jobs.push(job);
    persist();
    return job;
  }

  function list() {
    return jobs.map((j) => ({
      id: j.id,
      type: j.type,
      when: j.when || j.schedule,
      cmd: j.cmd,
      next: j.nextRun ? new Date(j.nextRun).toISOString() : null,
    }));
  }
}
