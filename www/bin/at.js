// at v1 — run a command once, later
//
// NAME
//      at — run a command once, later
//
// SYNOPSIS
//      at <when> <command...>
//      at -l | -r ID | -h
//
// DESCRIPTION
//      at schedules a one-shot job: the command runs through the shell
//      at the given time and its output appears in the terminal. Jobs
//      are session-scoped (like real at's queue) — they do not survive
//      a page reload.
//
// OPTIONS
//      <when>         now | +Ns | +Nm | +Nh | +Nd | HH:MM
//                     (HH:MM today, or tomorrow if already past)
//      -l, --list     list pending jobs
//      -r, --remove   remove a job by id
//      -h, --help     show this help
//
// EXAMPLES
//      at +10s echo done
//      at +5m ls /tmp
//      at 14:30 echo lunch

var TAB = String.fromCharCode(9);

function usage() {
  console.log("at — run a command once, later");
  console.log("usage: at <when> <command...>   (now | +Ns | +Nm | +Nh | +Nd | HH:MM)");
  console.log("       at -l · at -r ID · at -h");
  console.log("example: at +10s echo done");
}

if (args.length === 0) { usage(); return 2; }
if (!shell || !shell.jobs) {
  console.log("at: job scheduler not available in this shell");
  return 1;
}
var jobs = shell.jobs;

if (args[0] === "-h" || args[0] === "--help") { usage(); return 0; }

if (args[0] === "-l" || args[0] === "--list") {
  var list = jobs.list().filter(function (j) { return j.type === "at"; });
  if (list.length === 0) { console.log("at: no jobs scheduled"); return 0; }
  for (var i = 0; i < list.length; i++) {
    console.log(list[i].id + TAB + list[i].next + TAB + list[i].cmd);
  }
  return 0;
}

if (args[0] === "-r" || args[0] === "--remove") {
  var id = args[1];
  if (!id) { console.log("at: -r needs a job id (see: at -l)"); return 2; }
  var removed = jobs.remove(id);
  console.log(removed ? "at: removed " + id : "at: no such job " + id);
  return removed ? 0 : 1;
}

var when = args[0];
var cmd = args.slice(1).join(" ");
if (!cmd) {
  console.log("at: no command given (at +10s <command>)");
  return 2;
}
var res = jobs.addAt(when, cmd);
if (res.error) {
  console.log("at: bad time '" + when + "' (use now, +Ns, +Nm, +Nh, +Nd, or HH:MM)");
  return 2;
}
console.log("at: job " + res.id + " scheduled for " + new Date(res.nextRun).toString());
return 0;
