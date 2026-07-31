// ─── manpages.js: `man <command>` help pages ──────────────────
//
// Static Unix-style manual pages for every builtin command, shared
// by the CLI shell (src/tinysh.js) and the browser shell
// (www/index.html). Pages follow the classic layout:
//
//   NAME
//        command — one-line description
//   SYNOPSIS
//        usage line(s)
//   DESCRIPTION
//        what it does, how to use it
//   OPTIONS
//        flag reference (when applicable)
//   EXAMPLES
//        concrete invocations
//
// Commands without a static page fall back to:
//   • a .js command file's leading comment block (the file's header
//     doc comment becomes its manual page), or
//   • the one-line description known to the wasmer registry for
//     wasm32-wasi binaries installed in /bin/.
// -----------------------------------------------------------------

// Alias table: aliases point at the page of the command they stand in
// for, so `man vim`, `man dir`, `man cls` all show something useful.
export const MAN_ALIASES = {
  vim: "vi", nano: "edit", emacs: "edit",
  less: "cat", more: "cat", cls: "clear", dir: "ls",
  ll: "ls", la: "ls", q: "exit", quit: "exit", "?": "help",
  umount: "unmount", sh: "bash", chdir: "cd",
};

// One-line descriptions used by the man index (`man` with no args)
// and by `man -k` keyword search.
const SHORT = {
  ls: "list directory contents",
  cat: "print file contents (PNG/JPG/GIF render inline in the browser)",
  echo: "print text",
  pwd: "print working directory",
  cd: "change directory",
  export: "set environment variables",
  rm: "remove files",
  mkdir: "create directories",
  cp: "copy files",
  mv: "move (rename) files",
  head: "print the first N lines of a file or stdin",
  grep: "search files or stdin for a pattern",
  find: "find files by name and type",
  mount: "list mounts, or attach a remote repo as a filesystem",
  unmount: "detach a user-created mount",
  wasmer: "WASM package manager (list / install / search)",
  wat2wasm: "compile a .wat WebAssembly text file to .wasm",
  bash2js: "transpile bash to JavaScript (sh2perl → perl2js)",
  bash: "run bash commands: transpile to JS and execute",
  which: "show the path (or builtin) the shell would run",
  help: "shell help and overview",
  vi: "vi-style editor (CodeMirror vim keymap)",
  edit: "simple text editor",
  clear: "clear the terminal",
  resize: "report terminal size (COLUMNS × LINES)",
  stty: "report terminal size (rows cols)",
  history: "show command history (persists across refreshes)",
  locate: "find files anywhere under a directory",
  browse: "open current GitHub/GitLab dir in a new browser tab",
  play: "play an audio file (MP3/WAV/OGG)",
  more: "page through a file (alias for cat)",
  less: "page through a file (alias for cat)",
  true: "always succeed (exit 0)",
  false: "always fail (exit 1)",
  exit: "exit the shell",
  man: "show manual pages for commands",
};

// Full manual pages. Each entry is a template literal printed as-is.
export const MAN_PAGES = {
  man: `NAME
     man — display the manual page for a command

SYNOPSIS
     man [command]
     man -k <keyword>
     man -h | --help

DESCRIPTION
     man shows the manual page for a command, with its name,
     synopsis, description, options and examples. It is the classic
     Unix way to look up how a command works.

     With no arguments, man prints an index of every manual page
     available in this shell.

     Commands without a built-in manual page get one generated from
     their own documentation: a .js command file's leading comment
     block is shown as its manual page, and wasm32-wasi binaries
     installed with "wasmer install" show the package description.

OPTIONS
     -k <keyword>   Search the manual pages for <keyword> (like
                    apropos). Matches the command name and the
                    full text of every page.
     -h, --help     Show this page.

EXAMPLES
     man grep        The manual page for grep
     man ls          The manual page for ls
     man man         The manual page for man itself
     man             Index of all manual pages
     man -k search   Find every command whose page mentions "search"

SEE ALSO
     help — shell overview and list of builtin commands
`,
  ls: `NAME
     ls — list directory contents

SYNOPSIS
     ls [-l] [DIR...]

DESCRIPTION
     ls lists the contents of a directory (the current directory if
     none is given). Directory entries are colored: directories in
     blue, executables in green, regular files in white.

OPTIONS
     -l, --long   Long format: permissions, size, modification date
                  (and the mount each entry lives on).
     -la, -al     Same as -l (shortcuts for "ls -l -a" habits).

EXAMPLES
     ls               list the current directory
     ls /tmp          list /tmp
     ls /mount/github list a GitHub repo's root directory
     ls -l /bin       long listing of the command directory

SEE ALSO
     cd, find, pwd
`,
  cat: `NAME
     cat — print file contents

SYNOPSIS
     cat [FILE...]

DESCRIPTION
     cat writes the contents of each file to the terminal, one after
     the other. With no file arguments it copies stdin (pipe input)
     to stdout, so it is handy at the end of a pipeline.

     In the browser shell, image files (PNG, JPG, GIF, WebP) are
     rendered inline and audio files get play controls.

OPTIONS
     (none)

EXAMPLES
     cat README.md            print a text file
     cat note.txt todo.txt    print two files in order
     cat README.md | head -3  show the first three lines
     echo hi | cat            copy stdin to stdout
     cat /dev/info            browser/OS/device information
     cat logo.png             render an image in the browser terminal

SEE ALSO
     head, less, more
`,
  echo: `NAME
     echo — print text

SYNOPSIS
     echo <text...>

DESCRIPTION
     echo writes its arguments to the terminal, separated by spaces
     and followed by a newline. Quote arguments that contain spaces
     so they stay one word, or use them unquoted to join words with
     single spaces.

EXAMPLES
     echo hello
     echo "hello world"
     echo $HOME                expand the HOME environment variable
     echo "scale=2; 22/7" | bc  (with a bc.wasm installed)

SEE ALSO
     export, printf
`,
  pwd: `NAME
     pwd — print working directory

SYNOPSIS
     pwd

DESCRIPTION
     pwd prints the absolute path of the current directory, i.e.
     where the shell's relative paths resolve from.

EXAMPLES
     pwd
     cd /tmp && pwd             /tmp

SEE ALSO
     cd, export (PWD)
`,
  cd: `NAME
     cd — change directory

SYNOPSIS
     cd [DIR]

DESCRIPTION
     cd changes the shell's current directory. With no argument it
     goes to $HOME (/home). The new directory becomes $PWD, and
     relative paths (like cd examples) resolve against it.

     Note: the virtual filesystem's mount boundaries are not crossed
     by ".." — cd .. at a mount point stays at the mount point's
     root.

EXAMPLES
     cd            go to $HOME (/home)
     cd /tmp       switch to the ephemeral RAM disk
     cd /mount/github/gmatht/sh2perl   enter a GitHub repo
     cd ../docs    go up one level and into docs (inside one mount)

SEE ALSO
     pwd, mount, ls
`,
  export: `NAME
     export — set environment variables

SYNOPSIS
     export [NAME[=VALUE]...]
     export -p

DESCRIPTION
     export assigns values to environment variables. NAME=VALUE sets
     NAME to VALUE (split on the first '='); a bare NAME sets it to
     an empty string. With no arguments, or with -p, every variable
     is printed in POSIX export form.

     Variables are expanded with $NAME or \${NAME} when a command
     line is parsed. $PATH, $HOME, $USER and $PWD are the shell's
     built-in variables.

EXAMPLES
     export EDITOR=edit
     export PATH=/commands:/usr/bin:/bin
     export          print all variables
     echo $EDITOR    edit

SEE ALSO
     echo, env
`,
  rm: `NAME
     rm — remove files

SYNOPSIS
     rm <FILE...>

DESCRIPTION
     rm deletes each named file. It refuses nothing (there is no
     confirmation), so check the path twice — the virtual FS has no
     trash can.

EXAMPLES
     rm note.txt
     rm /tmp/scratch.bin
     ls && rm old.txt && ls

SEE ALSO
     mv, cp, mkdir
`,
  mkdir: `NAME
     mkdir — create directories

SYNOPSIS
     mkdir <DIR...>

DESCRIPTION
     mkdir creates each named directory. Paths are resolved against
     the current directory; missing parents are created implicitly
     (the virtual filesystem has no ENOENT parents).

EXAMPLES
     mkdir projects
     mkdir /home/projects/notes
     cd projects && mkdir a b c

SEE ALSO
     rm, ls
`,
  cp: `NAME
     cp — copy files

SYNOPSIS
     cp <SRC> <DEST>

DESCRIPTION
     cp reads SRC and writes its content to DEST, which may be a
     full path or a file name in the current directory. Binary
     content is preserved. In the browser, copying to /pc/ (the
     DownloadFS bridge) triggers a browser download of that file.

EXAMPLES
     cp note.txt note.bak
     cp /home/examples/hello.js .
     cp report.pdf /pc            download report.pdf from the browser
     cp /pc/photo.jpg /home       upload a file (file picker opens)

SEE ALSO
     mv, rm
`,
  mv: `NAME
     mv — move (rename) files

SYNOPSIS
     mv <SRC> <DEST>

DESCRIPTION
     mv copies SRC to DEST and then removes the source. It is the
     rename operation of the virtual filesystem.

EXAMPLES
     mv todo.txt done.txt
     mv /tmp/scratch /home/keep

SEE ALSO
     cp, rm
`,
  head: `NAME
     head — print the first N lines

SYNOPSIS
     head [-n N] [FILE...]

DESCRIPTION
     head prints the first N lines of each file, or of stdin when no
     file is given. The default count is 10.

OPTIONS
     -n N, --lines N   Print N lines (also accepted as -N, e.g. -3).
     -h, --help        Show this page.

EXAMPLES
     head README.md
     head -n 20 /home/examples/note.txt
     cat big.log | head -5
     ls /mount/github | head

SEE ALSO
     cat, tail, less
`,
  grep: `NAME
     grep — search files or stdin for a pattern

SYNOPSIS
     grep [OPTIONS] PATTERN [FILE...]

DESCRIPTION
     grep prints every line that matches the given pattern (a
     JavaScript regular expression). With no FILE arguments it
     searches stdin, so it is the classic filter at the end of a
     pipe. Multiple -e patterns match if any of them matches.

     Exit status: 0 if any line matched, 1 if none did, 2 on error.

OPTIONS
     -i, --ignore-case       Ignore case when matching.
     -n, --line-number       Prefix matching lines with their number.
     -v, --invert-match      Print non-matching lines instead.
     -c, --count             Print only the count of matches.
     -l, --files-with-matches  Print only file names with matches.
     -r, -R, --recursive     Search directories recursively.
     -e PAT, --regexp PAT    Add a pattern (repeatable; OR-combined).
     --                      Treat everything after as file names.
     -h, --help              Show this page.

EXAMPLES
     grep TODO README.md
     echo "hello world" | grep -i hello
     grep -rn "mount" /home
     grep -c "^#" ~/.tinyshrc        count comment lines in config
     grep -l wasm /commands/*.js

SEE ALSO
     find, cat, head
`,
  find: `NAME
     find — find files by name and type

SYNOPSIS
     find [PATH...] [EXPRESSION]

DESCRIPTION
     find walks the directory tree below each PATH (default: the
     current directory) and prints every entry that matches all the
     given tests. It is a depth-first walk; remote mounts (/github,
     /gitlab, /git, /http) are skipped unless named directly.

OPTIONS
     -name PATTERN     Match the basename with * and ? wildcards.
     -iname PATTERN    Same, case-insensitive.
     -type f|d         Match only files, or only directories.
     -maxdepth N       Descend at most N levels below the start.
     -mindepth N       Do not apply tests above level N.
     -print            Print matching paths (the default action).
     --                Treat everything after as start paths.

EXAMPLES
     find /home -name "*.txt"
     find . -name "*.js" -maxdepth 2
     find / -type d -name tmp
     find /commands -type f | head

SEE ALSO
     grep, ls
`,
  mount: `NAME
     mount — list mounts, or attach a remote repo as a filesystem

SYNOPSIS
     mount
     mount github:USER/REPO /PATH
     mount -h | --help

DESCRIPTION
     With no arguments mount lists the filesystems currently mounted
     on the virtual directory tree, each with its type and path.
     With a github:USER/REPO spec and a target path it attaches that
     repository as a read-only filesystem: its files appear under
     /PATH and can be listed and read like any local files.
     (GitLab and plain git repos use the same syntax with gitlab:
     and git: specs — see fs/gitlabfs.js and fs/gitfs.js.)

EXAMPLES
     mount
     mount github:gmatht/sh2perl /mymount
     ls /mymount
     cat /mymount/README.md
     unmount /mymount

SEE ALSO
     unmount, ls
`,
  unmount: `NAME
     unmount — detach a user-created mount

SYNOPSIS
     unmount <PATH>

DESCRIPTION
     unmount removes a mount that was created with "mount". The
     built-in mounts (/home, /tmp, /github, ...) cannot be removed;
     only mounts under /mount/ added at runtime can.

EXAMPLES
     mount github:gmatht/sh2perl /mymount
     unmount /mymount

SEE ALSO
     mount
`,
  wasmer: `NAME
     wasmer — WASM package manager for the browser shell

SYNOPSIS
     wasmer [list | search <term> | install <name> | help]

DESCRIPTION
     wasmer manages pre-compiled wasm32-wasi binaries. Packages are
     built by the repo's build-*.sh scripts and served from
     www/wasm-bin/. Once installed into /bin/, a package runs as a
     native command through the full WASI runtime (@wasmer/wasi), so
     real grep, python, curl etc. become shell commands.

COMMANDS
     list                 List available packages.
     search <term>        Search package names and descriptions.
     install <name>       Copy a package to /bin/<name>.wasm.
     help                 Show this page.

EXAMPLES
     wasmer list
     wasmer install grep
     echo "hello" | grep hello
     wasmer install python
     print(2+2) | python.wasm  (a python.wasm binary is runnable)

SEE ALSO
     which, man (for installed binaries)
`,
  wat2wasm: `NAME
     wat2wasm — compile WebAssembly text format to binary

SYNOPSIS
     wat2wasm <FILE.wat>

DESCRIPTION
     wat2wasm compiles a WebAssembly module written in the .wat text
     format (the wabt toolchain, compiled to wasm itself) into a
     .wasm binary written back next to the source file. Use it to
     hand-assemble small modules, or to see the binary form of a
     module you are learning WebAssembly with.

EXAMPLES
     wat2wasm /tmp/add.wat        writes /tmp/add.wasm

SEE ALSO
     wasmer, bash2js
`,
  bash2js: `NAME
     bash2js — transpile bash to JavaScript

SYNOPSIS
     bash2js 'SCRIPT'
     bash2js -f FILE.sh
     cat FILE.sh | bash2js

DESCRIPTION
     bash2js compiles bash source to JavaScript entirely in the
     browser. The pipeline is bash → Perl (sh2perl.wasm, a real bash
     compiler) → JS (perl2js). The generated JS targets the shell's
     runtime (rt + env); save it to a .js command file to run it
     again without the compiler.

OPTIONS
     -f FILE, --file FILE   Transpile a file from the virtual FS.
     -h, --help             Show this page.

EXAMPLES
     bash2js 'echo hello world'
     bash2js -f script.sh
     cat script.sh | bash2js > out.js

SEE ALSO
     bash (transpile and execute)
`,
  bash: `NAME
     bash — run bash commands by transpiling them to JS

SYNOPSIS
     bash 'SCRIPT'
     bash -c 'SCRIPT'
     bash FILE.sh
     cat FILE.sh | bash

DESCRIPTION
     bash transpiles bash source to JavaScript and executes it
     immediately. The compiler runs in the browser: bash → Perl
     (sh2perl.wasm) → JS (perl2js) → executed in the shell. Loops,
     conditionals, variables, arithmetic, pipes and command
     substitution work; pipelines run through the shell's own
     pipeline machinery.

OPTIONS
     -c, -e 'SCRIPT'   Run the inline script.
     -f FILE           Run a script file from the virtual FS.
     -h, --help        Show this page.

EXAMPLES
     bash 'for i in 1 2 3; do echo $i; done'
     bash 'x=1; while [ $x -lt 3 ]; do echo $x; x=$((x+1)); done'
     bash 'echo hi | grep h'
     cat script.sh | bash

SEE ALSO
     bash2js (transpile without executing)
`,
  which: `NAME
     which — show the path (or builtin) the shell would run

SYNOPSIS
     which <COMMAND...>

DESCRIPTION
     which resolves each command name exactly as the shell does and
     prints where it lives: "shell builtin" for builtins, a path
     (like /bin/grep.wasm) for command files and wasm binaries. It
     never downloads or runs anything, so it is safe to use on
     unknown names. Exit status is 1 if any name was not found.

EXAMPLES
     which grep        /bin/grep.wasm (after "wasmer install grep")
     which ls          ls: shell builtin
     which sl          which: no sl in (/commands:/usr/bin:/bin)

SEE ALSO
     wasmer, help
`,
  help: `NAME
     help — shell overview and list of builtin commands

SYNOPSIS
     help

DESCRIPTION
     help prints an overview of the shell: every builtin command
     with a one-line description, plus the features the shell has
     (pipes, conditionals, tab completion, history, the vi editor,
     /dev/ devices, mounts, startup config, aliases...).

     For detail on a single command, use man.

EXAMPLES
     help
     help | grep -i pipe

SEE ALSO
     man
`,
  vi: `NAME
     vi — vi-style editor (CodeMirror vim keymap)

SYNOPSIS
     vi <FILE>
     vim <FILE>          (alias)

DESCRIPTION
     vi opens the file in a CodeMirror editor with the vim keymap:
     normal mode (h j k l to move, x to delete, u to undo), insert
     mode (i a o), visual and command-line modes. The header shows
     the current mode. Save and quit with the ex commands below.
     Esc returns to the shell without saving; unsaved changes are
     lost.

EX COMMANDS
     :w        save
     :q        quit
     :wq       save and quit
     :x        save and quit
     :q!       quit without saving

EXAMPLES
     vi ~/.tinyshrc     edit the shell's startup config
     vi /home/notes.txt

SEE ALSO
     edit, cat
`,
  edit: `NAME
     edit — simple text editor

SYNOPSIS
     edit <FILE>

DESCRIPTION
     edit opens the file in a CodeMirror editor. Ctrl+S saves, Esc
     cancels (without saving). It is the shell's minimal editor; for
     a vi-style experience use vi (vim is an alias).

EXAMPLES
     edit ~/.tinyshrc
     edit /home/note.txt

SEE ALSO
     vi, cat
`,
  clear: `NAME
     clear — clear the terminal

SYNOPSIS
     clear

DESCRIPTION
     clear blanks the visible terminal viewport while respecting
     scrollback: output scrolled above stays in the terminal's
     history. Ctrl+L does the same.

EXAMPLES
     clear
     clear && pwd

SEE ALSO
     resize, stty
`,
  resize: `NAME
     resize — report the terminal size

SYNOPSIS
     resize

DESCRIPTION
     resize prints the terminal geometry as COLUMNS × LINES. The
     terminal tracks the window size automatically; $COLUMNS and
     $LINES are updated as you resize the browser window.

EXAMPLES
     resize
     echo "Terminal is $COLUMNS wide"

SEE ALSO
     stty, clear
`,
  stty: `NAME
     stty — report the terminal size

SYNOPSIS
     stty size

DESCRIPTION
     stty prints the terminal size as "rows cols", the traditional
     stty size output.

EXAMPLES
     stty size

SEE ALSO
     resize
`,
  history: `NAME
     history — show command history

SYNOPSIS
     history [N]

DESCRIPTION
     history prints the commands you have typed, oldest first, with
     an index. It persists across page refreshes (stored in the
     browser). Up/Down arrows recall entries at the prompt.

EXAMPLES
     history
     history 20
     history | grep man

SEE ALSO
     man
`,
  locate: `NAME
     locate — find files anywhere under a directory

SYNOPSIS
     locate <PATTERN> [DIR]

DESCRIPTION
     locate walks the given directory (default: the whole virtual
     filesystem) and prints every path whose name contains the
     pattern. It is a simpler, fuzzier alternative to find:
     substring match instead of shell wildcards.

EXAMPLES
     locate wasm
     locate note /home
     locate .js /commands

SEE ALSO
     find, grep
`,
  browse: `NAME
     browse — open the current directory in a new browser tab

SYNOPSIS
     browse [PATH]

DESCRIPTION
     browse opens PATH in a new browser tab. On a GitHub or GitLab
     mount (/github, /mount/github, /gitlab, ...) it opens the
     matching web page on github.com / gitlab.com; elsewhere it
     falls back to the raw URL the mount is backed by, and outside
     mounts it does nothing useful (there is no web URL for /home).

EXAMPLES
     cd /mount/github/gmatht/sh2perl && browse
     browse /gitlab/group/project

SEE ALSO
     mount
`,
  play: `NAME
     play — play an audio file

SYNOPSIS
     play <FILE>

DESCRIPTION
     play plays an audio file (MP3, WAV, OGG) in the browser with
     playback controls: play/pause, seek, and a volume slider.

EXAMPLES
     play /home/music.mp3
     cp /pc/song.wav /home && play /home/song.wav

SEE ALSO
     cat (images render inline)
`,
  more: `NAME
     more — page through a file (alias for cat)

SYNOPSIS
     more <FILE>

DESCRIPTION
     more is an alias for cat: it prints the file to the terminal.
     In the browser the terminal scrolls, so paging is native.

SEE ALSO
     cat, less
`,
  less: `NAME
     less — page through a file (alias for cat)

SYNOPSIS
     less <FILE>

DESCRIPTION
     less is an alias for cat: it prints the file to the terminal.
     In the browser the terminal scrolls, so paging is native.

SEE ALSO
     cat, more
`,
  true: `NAME
     true — always succeed (exit 0)

SYNOPSIS
     true

DESCRIPTION
     true does nothing and exits 0. Handy with && chains to force a
     branch, or as a placeholder.

EXAMPLES
     true && echo "this always runs"
     grep x f.txt || true

SEE ALSO
     false
`,
  false: `NAME
     false — always fail (exit 1)

SYNOPSIS
     false

DESCRIPTION
     false does nothing and exits 1. Handy with || chains, or to
     test conditional logic.

EXAMPLES
     false || echo "this always runs"
     false && echo never

SEE ALSO
     true
`,
  exit: `NAME
     exit — exit the shell

SYNOPSIS
     exit
     q, quit          (aliases)

DESCRIPTION
     exit leaves the shell. In the browser it disables the input
     line; Ctrl+D at an empty prompt does the same. In the CLI it
     terminates the process.

SEE ALSO
     help
`,
};

// ─── Helpers ───────────────────────────────────────────────────

// Resolve an alias to the canonical page name (falling back to the
// name itself, so `man vim` → vi while `man vim` also shows vi's
// page name in its header).
export function canonicalName(name) {
  return MAN_ALIASES[name] || name;
}

// Index of every static page: "name — short description".
export function manIndex() {
  return Object.keys(MAN_PAGES)
    .sort()
    .map((n) => `${n.padEnd(10)} ${SHORT[n] || "no description"}`);
}

// Search name + short description + full text of every page for the
// given keyword (case-insensitive). Returns lines "name — desc".
export function searchManPages(term) {
  const t = String(term).toLowerCase();
  if (!t) return manIndex();
  const out = [];
  for (const name of Object.keys(MAN_PAGES).sort()) {
    const desc = SHORT[name] || "";
    const text = MAN_PAGES[name] || "";
    if (
      name.toLowerCase().includes(t) ||
      desc.toLowerCase().includes(t) ||
      text.toLowerCase().includes(t)
    ) {
      out.push(`${name.padEnd(10)} ${desc}`);
    }
  }
  return out;
}

// Extract a .js command file's leading comment block (the header doc
// comment) as a manual page. Handles both:
//   // line comments at the top of the file
//   /* ... */ block comment at the top
// The rest of the file's content is ignored. Returns null when the
// file has no leading comment to offer.
export function commentToManPage(source) {
  const text = String(source);
  if (!text.trim()) return null;

  // /* ... */ block comment at the very start
  if (/^\s*\/\*/.test(text)) {
    const end = text.indexOf("*/");
    if (end !== -1) {
      const block = text.slice(text.indexOf("/*") + 2, end);
      return block
        .split("\n")
        .map((l) => l.replace(/^\s*\* ?/, ""))
        .join("\n")
        .trim();
    }
  }

  // Leading // line comments (with blank comment lines allowed)
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*\/\/\s?(.*)$/);
    if (m) {
      out.push(m[1]);
    } else if (!line.trim()) {
      if (out.length) out.push(""); // blank line inside the header
      else continue;                // leading blank line — skip
    } else {
      break; // first non-comment line ends the header
    }
  }
  const page = out.join("\n").trim();
  return page.length ? page : null;
}

// Full lookup used by the `man` builtin:
//   1. static page (after alias resolution)
//   2. header comment of a .js command file found via fs
//   3. description from a wasmer registry entry (wasm binaries)
//   4. otherwise null (caller prints "no manual entry")
export async function getManPage(name, { fs, wasmerReg } = {}) {
  const canon = canonicalName(name);
  if (MAN_PAGES[canon]) return { name: canon, source: "manual", text: MAN_PAGES[canon] };

  // .js command files often start with a doc comment — use it.
  if (fs && typeof fs.read === "function") {
    for (const dir of ["/commands", "/bin", "/usr/bin", "/home/examples", "."]) {
      try {
        const content = await fs.read(`${dir}/${name}.js`);
        const page = commentToManPage(content);
        if (page) return { name, source: `${dir}/${name}.js`, text: page };
      } catch {
        // not there — try the next directory
      }
    }
    // A bare file name that is itself a .js path
    if (name.endsWith(".js")) {
      try {
        const content = await fs.read(name);
        const page = commentToManPage(content);
        if (page) return { name, source: name, text: page };
      } catch {
        // fall through
      }
    }
  }

  // wasm32-wasi binaries installed with `wasmer install` — use the
  // registry's one-line description.
  if (wasmerReg && typeof wasmerReg.list === "function") {
    const pkg = wasmerReg.list().find((p) => p.name === name);
    if (pkg) {
      return {
        name,
        source: `/bin/${name}.wasm`,
        text: `NAME
     ${name} — ${pkg.desc}

DESCRIPTION
     A wasm32-wasi binary installed with "wasmer install ${name}".
     It runs as a native command through the full WASI runtime
     (@wasmer/wasi) with the virtual filesystem bridged in.

     Package: ${pkg.desc}

SEE ALSO
     wasmer
`,
      };
    }
  }

  return null;
}
