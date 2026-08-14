// ─── runReplLine: evaluate one line in an active REPL (python/bash/cmd/perl) ──
// SHARED by both shells — the language engines (py.js, bash2js, bat2js,
// zeroperl) and the session-replay logic are one copy; only the input
// transport differs (terminal readline vs DOM modal), which comes from
// ctx { replState, stdout, stderr, exitRepl, promptRepl, runBash,
// runNestedCommand, fs }.
export async function runReplLine(line, ctx) {
  if (ctx.ctx.replState.mode === "python") {
    const t = line.trim();
    if (t === "exit()" || t === "quit()") { ctx.exitRepl(); return; }
    try {
      const { pyExec } = await import("../py.js");
      await pyExec(line, { stdout: ctx.stdout, stderr: ctx.stderr });
    } catch (e) {
      ctx.stderr.write(`python: ${e.message}\n`);
    }
  } else if (ctx.ctx.replState.mode === "bash") {
    const t = line.trim();
    if (!t) return;
    // exit / quit / "exit 5" leave the REPL (never reach the shell's exit)
    if (t === "exit" || t === "quit" || t === ":q" ||
        t.indexOf("exit ") === 0 || t.indexOf("quit ") === 0) { ctx.exitRepl(); return; }
    try {
      // Session replay: re-transpile and re-run every line so far plus
      // the new one, bracketed by two echo markers (PRE before the new
      // line, POST after). debashcl silently DROPS invalid statements
      // (and everything after them), so if POST is missing the line was
      // never run — we report it and leave the session untouched.
      // Variables and functions persist because the whole session
      // re-declares them; only the output between the markers is shown.
      // runBash rewrites the marker echos to direct stdout writes, so
      // the PRE marker can't clobber $? for the new line (`false` then
      // `echo $?` must print 1, like bash).
      ctx.replState.bashOut = "";
      const session = ctx.replState.bashSession;
      const pre = ctx.replState.bashMarker;
      const post = ctx.replState.bashMarker + "_end";
      const src = (session.length > 0 ? session.join("\n") + "\n" : "") +
        "echo '" + pre + "'\n" + line + "\necho '" + post + "'\n";
      const { runBash } = await import("../bash2js.js");
      await runBash(ctx.fs, src, {
        runCmd: ctx.runNestedCommand,
        stdout: { write: (s) => { ctx.replState.bashOut += s; } },
        stderr: { write: (s) => { ctx.replState.bashOut += ctx.stderrColorFn ? ctx.stderrColorFn(s) : s; } },
        markers: [pre, post],
      });
      const pi = ctx.replState.bashOut.indexOf(pre);
      const pj = ctx.replState.bashOut.lastIndexOf(post);
      if (pi === -1 || pj === -1 || pj < pi) {
        // POST never printed — the statement was dropped/truncated
        ctx.stderr.write("bash: syntax error — the line was not run (session unchanged)\n");

      } else {
        // The PRE marker's echo appends its own newline, so the slice
        // after it starts with "\n" — strip it, or every command's
        // output would be preceded by a blank line (and no-output lines
        // like `x=5` would print one).
        const fresh = ctx.replState.bashOut.slice(pi + pre.length, pj).replace(/^\n+/, "");
        if (fresh) ctx.stdout.write(fresh);
        session.push(line);
      }
    } catch (e) {
      ctx.stderr.write(`bash: ${(e && e.message) ? e.message : String(e)}\n`);
    }
  } else if (ctx.ctx.replState.mode === "cmd") {
    const t = line.trim();
    if (!t) return;
    // exit / exit /b N / quit leave the REPL (never reach the shell's exit)
    if (/^(exit|quit)\b/.test(t) || t === ":q") { ctx.exitRepl(); return; }
    try {
      // Session replay: re-transpile and re-run every line so far plus
      // the new one, bracketed by two echo markers (PRE before the new
      // line, POST after). The bat frontend REFUSES loud (unlike bash's
      // silent drop), so if POST is missing the line never ran — we
      // report it and leave the session untouched. Variables persist
      // because the whole session re-declares them; only the output
      // between the markers is shown. Batch `echo` compiles to a direct
      // stdout write (no exec), so the PRE marker can't clobber
      // %errorlevel% for the new line (`exit /b 5` then `echo
      // %errorlevel%` must print 5, like cmd).
      ctx.replState.cmdOut = "";
      const session = ctx.replState.cmdSession;
      const pre = ctx.replState.cmdMarker;
      const post = ctx.replState.cmdMarker + "_end";
      const src = (session.length > 0 ? session.join("\n") + "\n" : "") +
        "echo " + pre + "\n" + line + "\necho " + post + "\n";
      const { runBat } = await import("../bat2js.js");
      await runBat(ctx.fs, src, {
        runCmd: ctx.runNestedCommand,
        stdout: { write: (s) => { ctx.replState.cmdOut += s; } },
        stderr: { write: (s) => { ctx.replState.cmdOut += ctx.stderrColorFn ? ctx.stderrColorFn(s) : s; } },
      });
      const pi = ctx.replState.cmdOut.indexOf(pre);
      const pj = ctx.replState.cmdOut.lastIndexOf(post);
      if (pi === -1 || pj === -1 || pj < pi) {
        // POST never printed — the statement was refused/truncated
        ctx.stderr.write("cmd.exe: syntax error — the line was not run (session unchanged)\n");
      } else {
        // The PRE marker's echo appends its own newline, so the slice
        // after it starts with "\n" — strip it, or every command's
        // output would be preceded by a blank line (and no-output lines
        // like `set X=5` would print one).
        const fresh = ctx.replState.cmdOut.slice(pi + pre.length, pj).replace(/^\n+/, "");
        if (fresh) ctx.stdout.write(fresh);
        session.push(line);
      }
    } catch (e) {
      ctx.stderr.write(`cmd.exe: ${(e && e.message) ? e.message : String(e)}\n`);
    }
  } else {
    const t = line.trim();
    if (t === "exit" || t === "quit" || t === ":q") { ctx.exitRepl(); return; }
    try {
      await ctx.replState.perlReady;
      if (!ctx.ctx.replState.active) return;
      // Session replay: re-run every line so far plus the new one, with
      // a marker printed between the old code and the new line. `my`
      // lexicals from earlier lines survive because they're re-declared
      // in the same eval; only the output after the marker is shown.
      ctx.replState.perlOut = "";
      const session = ctx.replState.perlSession;
      // Separate statements with ";" — a bare newline doesn't end a Perl
      // statement (my $x=9 works as the last line of an eval but breaks
      // when more code follows), and only successful lines join the
      // session so an error never poisons the replay.
      const code = (session.length > 0 ? session.join(";\n") + ";\n" : "") +
        "print " + JSON.stringify(ctx.replState.perlMarker + "\n") + ";\n" +
        line;
      const res = await ctx.replState.perl.eval(code, []);
      try { ctx.replState.perl.flush(); } catch (e) {}
      const marker = ctx.replState.perlMarker;
      const splitAt = ctx.replState.perlOut.lastIndexOf(marker + "\n");
      if (splitAt !== -1) {
        const fresh = ctx.replState.perlOut.slice(splitAt + marker.length + 1);
        if (fresh) ctx.stdout.write(fresh);
      }
      if (res && res.success && line.trim()) session.push(line);
      if (res && !res.success && res.error) ctx.stderr.write(String(res.error));
    } catch (e) {
      ctx.stderr.write(`perl: ${e.message}\n`);
    }
  }
}
