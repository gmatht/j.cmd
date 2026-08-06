// cron v1 — periodic jobs (5-field schedule)
//
// NAME
//      cron — periodic jobs
//
// SYNOPSIS
//      cron add "SCHEDULE" <command...>
//      cron list | -l | rm ID | clear | -h
//
// DESCRIPTION
//      cron runs commands on a schedule, like the classic crontab.
//      Jobs persist in /home/.jtshcron and are re-armed when the
//      shell starts, so they survive reloads. The scheduler ticks
//      every 30s and runs each due job through the shell (its output
//      appears in the terminal).
//
// SCHEDULE
//      min hour dom mon dow      five fields, space separated
//        *      every value      */N    every N
//        N-M    a range          A,B    a list
//      dow: 0 or 7 = Sunday. Examples:
//        "* * * * *"        every minute
//        "*/5 * * * *"      every 5 minutes
//        "0 9 * * 1-5"      weekdays at 09:00
//        "30 8 * * *"       08:30 daily
//
// EXAMPLES
//      cron add "*/5 * * * *" echo tick
//      cron add "0 9 * * 1-5" echo work
//      cron list · cron rm c1 · cron clear

var TAB = String.fromCharCode(9);

function usage() {
  console.log("cron — periodic jobs (5-field schedule)");
  console.log('usage: cron add "SCHEDULE" <command> · cron list · cron rm ID · cron clear');
  console.log("schedule: min hour dom mon dow   (* | */N | N-M | A,B)");
  console.log('example: cron add "*/5 * * * *" echo tick');
}

if (args.length === 0) { usage(); return 2; }
if (!shell || !shell.jobs) {
  console.log("cron: job scheduler not available in this shell");
  return 1;
}
var jobs = shell.jobs;

if (args[0] === "-h" || args[0] === "--help") { usage(); return 0; }

if (args[0] === "add" || args[0] === "-a") {
  var schedule = args[1];
  var cmd = args.slice(2).join(" ");
  if (!schedule || !cmd) {
    console.log('cron: usage: cron add "SCHEDULE" <command>');
    return 2;
  }
  var res = jobs.addCron(schedule, cmd);
  if (res.error) {
    console.log("cron: bad schedule '" + schedule + "' (min hour dom mon dow · see cron -h)");
    return 2;
  }
  console.log("cron: job " + res.id + " added — next run " + new Date(res.nextRun).toString());
  return 0;
}

if (args[0] === "list" || args[0] === "-l" || args[0] === "ls") {
  var list = jobs.list().filter(function (j) { return j.type === "cron"; });
  if (list.length === 0) {
    console.log('cron: no jobs (cron add "SCHEDULE" <command>)');
    return 0;
  }
  for (var i = 0; i < list.length; i++) {
    console.log(list[i].id + TAB + list[i].when + TAB + list[i].next + TAB + list[i].cmd);
  }
  return 0;
}

if (args[0] === "rm" || args[0] === "remove") {
  var id = args[1];
  if (!id) { console.log("cron: rm needs a job id (see: cron list)"); return 2; }
  var removed = jobs.remove(id);
  console.log(removed ? "cron: removed " + id : "cron: no such job " + id);
  return removed ? 0 : 1;
}

if (args[0] === "clear") {
  jobs.clear();
  console.log("cron: all jobs removed");
  return 0;
}

console.log("cron: unknown command '" + args[0] + "' (add, list, rm, clear)");
usage();
return 2;
