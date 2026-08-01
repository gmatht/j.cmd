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
  mount: "list mounts, attach a repo, or bind an existing dir (admin only)",
  unmount: "detach a user-created mount (bind mounts too)",
  wasmer: "WASM package manager (list / install / search)",
  go: "run/build Go programs — the REAL Go toolchain (cmd/compile + cmd/link) as WASM",
  nethack: "play NetHack 3.6.7 — the real game, compiled to WASM (browser)",
  jobs: "list background jobs (&)",
  wait: "wait for background jobs",
  kill: "terminate (or dismiss) a background job",
  wat2wasm: "compile a .wat WebAssembly text file to .wasm",
  qbe2wasm: "compile QBE IR (cproc output) to a wasm binary",
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
  arecord: "record microphone audio (arecord-compatible options)",
  perl: "Perl 5 interpreter (zeroperl wasm)",
  lua: "Lua 5.4 interpreter (wasmoon wasm)",
  time: "run a command and report how long it took",
  watch: "run a command repeatedly and refresh the display",
  diff: "compare two files (wasm-diff engine, vendored wasm)",
  cowsay: "a talking cow (and friends)",
  fortune: "print a random quotation",
  figlet: "big ASCII banner text (fonts, style, size)",
  sl: "steam locomotive — the ls typo",
  cmatrix: "Matrix-style digital rain",
  at: "run a command once, later",
  cron: "periodic jobs (5-field schedule, persisted)",
  curl: "transfer data from URLs (fetch-based)",
  gzip: "compress files (gzip format)",
  gunzip: "decompress gzip files",
  zstd: "compress/decompress with zstd (real CLI, wasm32-wasi)",
  md5sum: "compute MD5 checksums",
  sha256sum: "compute SHA-256 checksums",
  tar: "create, list and extract tar archives",
  tree: "recursive directory listing",
  uptime: "how long the shell has been running",
  zip: "package files into a ZIP archive",
  markdown: "render Markdown → HTML (md4c wasm; preview in edit)",
  plot: "ASCII line charts in the terminal",
  magick: "convert/resize/identify images (canvas-based, browser)",
  convert: "convert/resize images (alias for magick)",
  ffmpeg: "convert media files (ffmpeg.wasm, browser)",
  typist: "typing speed and accuracy practice",
  screen: "split the terminal into panes (tmux-style, browser)",
  more: "page through a file (alias for cat)",
  less: "page through a file (alias for cat)",
  true: "always succeed (exit 0)",
  whoami: "print the current user",
  su: "switch users — drop to an unprivileged account",
  chmod: "change file mode bits (octal, enforced)",
  chroot: "change the root directory (admin only)",
  false: "always fail (exit 1)",
  exit: "exit the shell",
  man: "show manual pages for commands",
};

// Full manual pages. Each entry is a template literal printed as-is.
export const MAN_PAGES = {
  whoami: `NAME
     whoami — print the current user

SYNOPSIS
     whoami

DESCRIPTION
     Prints the effective user name (the $USER environment variable).
     After "su nobody" this reports nobody.

SEE ALSO
     su
`,
  su: `NAME
     su — switch users

SYNOPSIS
     su [user]
     su -

DESCRIPTION
     su switches the shell to another account. With no argument it drops
     to nobody, an unprivileged user with its own home directory
     (/home/nobody). su tinysh (or su root) returns to the admin
     account, restoring the directory you were in before su.

     Switching to nobody, daemon, guest or www-data marks the session as
     unprivileged: the prompt and status bar show the user name, and
     the new account gets its own home directory with a welcome note on
     first visit.

     Permissions are real and enforced at the filesystem layer: files
     carry an owner and Unix-style mode bits, and every read/write/list
     checks the current user against them. su nobody cannot read a 0600
     file owned by tinysh (EACCES), cannot write into tinysh's home,
     and cannot chmod files it does not own. tinysh and root bypass the
     checks. Modes are set with chmod.

EXAMPLES
     su                    drop to nobody
     su daemon             switch to the daemon account
     whoami                nobody
     echo $HOME            /home/nobody
     su tinysh             back to the admin account

SEE ALSO
     whoami
`,  chmod: `NAME
     chmod — change file mode bits

SYNOPSIS
     chmod OCTAL file...

DESCRIPTION
     Sets the Unix-style mode bits of a file or directory. Only the
     owner (or tinysh/root) may change a mode. Octal forms: 600 =
     owner read/write, 644 = also readable by others, 700 = private
     directory, 755 = public directory.

     The filesystem enforces these bits: reads need the read bit, writes
     need the write bit (plus traverse on the parent directory), and
     listing a directory needs its read bit.

EXAMPLES
     chmod 600 secret.txt     private — only the owner can read/write
     chmod 644 notes.txt      owner rw, everyone else read
     chmod 755 /home/public   traversable and listable by everyone

SEE ALSO
     su
`,

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
     export PATH=/bin:/usr/bin
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
     grep -l wasm /bin/*.js

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
     find /bin -type f | head

SEE ALSO
     grep, ls
`,
  chroot: `NAME
     chroot — change the root directory

SYNOPSIS
     chroot <dir>
     chroot -

DESCRIPTION
     Confines the shell to a new root: "/" becomes <dir>, so paths like
     /etc/passwd resolve inside it. Only the admin (tinysh/root) may
     chroot. The prompt, pwd and the status bar show the confined view;
     chroot - returns to the real root and the directory you were in.

     Permissions still apply inside the chroot — it confines the view,
     it does not bypass ownership or mode bits. Combining chroot with su
     gives a real jail: su nobody; chroot /home/nobody.

EXAMPLES
     chroot /home/nobody    "/" is now /home/nobody
     ls /                   the chroot root's contents
     chroot -               back to the real root

SEE ALSO
     su
`,
  watch: `NAME
     watch — run a command repeatedly and refresh the display

SYNOPSIS
     watch [-n SECONDS] <command> [args...]

DESCRIPTION
     watch runs the given command every SECONDS (default 2) and
     refreshes the display in place. The browser shell renders a
     self-refreshing panel above the prompt; the Node CLI clears the
     screen with ANSI sequences, like the real watch. Ctrl+C stops it.

OPTIONS
     -n, --interval=SECONDS   seconds between runs
     -h, --help               show help

SEE ALSO
     time
`,
  mount: `NAME
     mount — attach a filesystem at a path

SYNOPSIS
     mount
     mount github:user/repo /path
     mount --bind <src> <dst>

DESCRIPTION
     With no arguments mount lists the filesystems. mount
     github:user/repo /path attaches a GitHub repository. mount --bind
     re-exposes an existing directory at another path; both operations
     are admin-only (an unprivileged user could otherwise bind a
     directory over a protected one and bypass permissions).

     Bind mounts share the underlying files, so permission checks
     translate back to the original paths — a bind never bypasses
     ownership or mode bits. Detach with unmount.

SEE ALSO
     unmount
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
     www/wasm-bin/. Once installed into /usr/bin/, a package runs as a
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
  qbe2wasm: `NAME
     qbe2wasm — compile QBE IL to a wasm binary

SYNOPSIS
     qbe2wasm [-o OUT.wasm] [-w] [FILE.qbe]
     cat FILE.qbe | qbe2wasm -o OUT.wasm

DESCRIPTION
     qbe2wasm is the in-shell C backend: it compiles QBE Intermediate
     Language (the text IR emitted by the cproc C compiler, e.g.
     "cproc-qbe -o out.qbe prog.c") into a WebAssembly binary. This is
     the "assembler" half of the C toolchain — JavaScript is the binary
     format, and the engine (src/qbe2wasm.js) is injected into commands
     by the shell.

     Locals become a bump-allocated stack (module-level stack pointer
     global); phis lower to a shared local; cproc's reducible control
     flow (if/else joins, while/for/do-while, break/continue, switch)
     lowers to wasm block/loop/if. Float literals (s_1.5, d_25) and
     mixed w/l arithmetic are supported.

OPTIONS
     -o OUT.wasm   write the binary to OUT.wasm (default a.wasm)
     -w            emit a memory64 module (i64 addresses, >4GiB)
     -h            show usage

EXAMPLES
     qbe2wasm /tmp/hello.qbe               writes /tmp/a.wasm
     qbe2wasm -w -o fib.wasm /tmp/t2.qbe   memory64 build

SEE ALSO
     cc, wat2wasm
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
     which grep        /usr/bin/grep.wasm (after "wasmer install grep")
     which ls          ls: shell builtin
     which sl          which: no sl in (/bin:/usr/bin)

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
     locate .js /bin

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
  arecord: `NAME
     arecord — record microphone audio

SYNOPSIS
     arecord [options] [file]

DESCRIPTION
     arecord records the browser microphone to the virtual
     filesystem, with options mirroring the ALSA arecord command:
     -d duration, -f format, -r rate, -c channels, -t file type and
     -D device. The browser microphone is a mono source; -c 2
     duplicates it into both channels, and recordings are resampled
     to -r.

     With no [file] it records to $HOME/pcm.wav. Use a /pc/ path to
     download the result (e.g. /pc/rec.wav). A file of "-" prints a
     base64 data URL (the shell's stdout is text). Recording cannot
     be interrupted mid-flight: Ctrl+C returns to the prompt, but the
     recording finishes its -d seconds and still writes the file.

OPTIONS
     -d, --duration=SECONDS  record for SECONDS (default 10)
     -f, --format=FORMAT     S16_LE (default), U8, S8, S24_LE, S32_LE,
                             FLOAT_LE and their _BE twins; cd and dat
                             are presets (cd: 16-bit 44100 Hz stereo)
     -r, --rate=HZ           sample rate (default 8000, like arecord)
     -c, --channels=N        1 (default) or 2 (stereo mix of mono mic)
     -t, --file-type=TYPE    wav (default), raw or au
     -D, --device=NAME       microphone: default or a deviceId from
                             arecord -l
     -l, --list-devices      list capture hardware
     -L, --list-pcms         list PCM names
     -q, --quiet             suppress status lines
     -v, --verbose           extra diagnostics
     -h, --help              show help

EXAMPLES
     arecord -d 5 out.wav
     arecord -f cd -d 3 song.wav
     arecord -r 16000 -c 1 -f S16_LE -d 2 clip.wav
     arecord -d 2 -t raw clip.pcm
     arecord -l

SEE ALSO
     play, /dev/audio (audiodemo)
`,
  markdown: `NAME
     markdown — render Markdown to HTML (md4c)

SYNOPSIS
     markdown [file.md] | cat file.md | markdown

DESCRIPTION
     Renders Markdown to HTML with rsms/markdown-wasm (the same
     CommonMark engine the npm package uses), compiled to wasm32-wasi.
     Reads stdin when no file is given. Extensions on: tables,
     strikethrough, tasklists, permissive autolinks, underline.

EXAMPLES
     echo '# hi' | markdown
     markdown README.md > /pc/readme.html
     (edit README.md shows a live preview — :preview toggles)
`,
  plot: `NAME
     plot — ASCII line charts in the terminal

SYNOPSIS
     plot [options] [file|-] · plot -e EXPR

DESCRIPTION
     Plots columns from a file/stdin (first column = x, rest are
     series) or an expression (-e) over [xmin,xmax] (default 0..2π;
     sin/cos/exp/log/sqrt/… work bare). Renders an ASCII chart with
     axes — the shell's quick answer to gnuplot for data & functions.

OPTIONS
     -w N · -h N · -t title · -xmin/-xmax/-ymin/-ymax

EXAMPLES
     plot -e "sin(x)" -xmax 6.283
     cat data.txt | plot -w 80 -h 20 -t "sensor"
`,
  magick: `NAME
     magick — convert, resize and identify images

SYNOPSIS
     magick input.png output.jpg [-resize WxH] [-quality N]
     magick -info file

DESCRIPTION
     ImageMagick-style image tool. In the browser it converts between
     png/jpeg/webp/gif on the canvas (resize, quality). -info works
     everywhere via header parsing (PNG/GIF/JPEG/WebP). Real
     ImageMagick wasm builds are Emscripten-glued and can't run under
     this shell's WASI host, so this JS command covers the everyday
     cases. convert is an alias.

EXAMPLES
     magick /home/photo.png /home/photo.jpg -resize 50%
     magick -info /home/photo.png
`,
  convert: `NAME
     convert — convert/resize images (alias for magick)

SYNOPSIS
     convert input output [-resize WxH]

DESCRIPTION
     Alias for magick. See: man magick
`,
  ffmpeg: `NAME
     ffmpeg — convert media files (ffmpeg.wasm, browser)

SYNOPSIS
     ffmpeg -i input.mp4 [opts] output.mp4

DESCRIPTION
     Runs the official ffmpeg.wasm (@ffmpeg/ffmpeg + @ffmpeg/core,
     ~30MB, fetched from a CDN on first use) with VFS files bridged
     into ffmpeg's in-memory filesystem. The core is Emscripten-glued
     (not WASI), so this runs in the browser only. Output is written
     back to the VFS — play it with 'play', view with 'cat'.

EXAMPLES
     ffmpeg -i /home/in.mp4 -vf scale=320:240 /home/out.gif
     ffmpeg -i /home/in.webm -c:v libx264 /home/out.mp4
`,
  typist: `NAME
     typist — typing speed and accuracy practice

SYNOPSIS
     typist · typist demo

DESCRIPTION
     Shows a passage and types it character by character (browser,
     via the shell.onKey hook); wrong keys count against accuracy,
     Backspace rewinds, Enter/Esc ends early, live WPM on finish.
     'typist demo' types the passage by itself (works in the CLI).
`,
  screen: `NAME
     screen — split the terminal into panes

SYNOPSIS
     screen [-n N] [-S name]

DESCRIPTION
     screen takes over the browser terminal with a tmux-style pane
     layout. Each pane is its own mini-shell: its own working
     directory, its own output area and its own input line. Commands
     run in a pane exactly as they would in the main shell (builtins,
     .js command files, wasm binaries), but their output stays inside
     the pane.

     Browser keyboards make tmux hotkeys unreliable, so every action
     is a button: + adds a pane, x closes one, C clears its output,
     = resets to a single pane, q (or Esc) leaves screen mode. Click
     a pane to focus it; Enter or Run runs its line. Commands run one
     at a time across panes, and a command that cd's changes only its
     own pane. Full-screen commands (edit, vi, play, browse, the
     python REPL) are refused in panes.

OPTIONS
     -n, --panes=N     start with N panes (default 1, max 16)
     -S, --session=N   session name shown in the toolbar (default tinysh)
     -h, --help        show this help

EXAMPLES
     screen               one pane, split it with the + button
     screen -n 4          2x2 grid of panes
     screen 4             same as -n 4
     screen -S work -n 2  session named work with two panes

SEE ALSO
     arecord, play
`,
  perl: `NAME
     perl — Perl 5 interpreter

SYNOPSIS
     perl [-e CODE] [script.pl] [args...]
     echo 'print 6*7' | perl

DESCRIPTION
     perl runs Perl 5.42 compiled to WebAssembly (the zeroperl project,
     via the @6over3/zeroperl-ts npm package, 24 MiB). The script is
     registered into the interpreter's virtual filesystem; @ARGV is set
     from the trailing arguments and stdout/stderr flow to the shell.
     Scripts come from the shell's filesystem or a pipe.

OPTIONS
     -e CODE   evaluate inline Perl code
     -E CODE   same as -e (modern Perl features: say, state, ...)
     -         read the script from stdin
     -h        show help

EXAMPLES
     perl -e 'print 6*7'
     perl -e 'print join(",", @ARGV)' a b c
     echo 'print "hi"' | perl
     perl /home/hello.pl world

SEE ALSO
     lua, python, wasmer
`,
  lua: `NAME
     lua — Lua 5.4 interpreter

SYNOPSIS
     lua [-e CODE] [script.lua] [args...]
     echo 'print(6*7)' | lua

DESCRIPTION
     lua runs Lua 5.4 compiled to WebAssembly (wasmoon, 0.3 MiB).
     print and io.write are routed to the shell; the trailing arguments
     appear in the standard Lua arg table (arg[0] is the script name);
     scripts come from the shell's filesystem or a pipe.

OPTIONS
     -e CODE   evaluate inline Lua code
     -         read the script from stdin
     -h        show help

EXAMPLES
     lua -e 'print(6*7)'
     lua -e 'for i=1,3 do print(i) end'
     echo 'print("hi")' | lua
     lua /home/hello.lua world

SEE ALSO
     perl, python, wasmer
`,
  llm: `NAME
     llm — agentic coder (pi-style read/write/edit/bash core)

SYNOPSIS
     llm <task>
     llm --plain <question>
     llm [-m MODEL] [--base URL] [-s N] <task>
     llm --list

DESCRIPTION
     llm turns a prompt into an agent loop: the model gets a minimal
     four-tool core — read, write, edit and bash — and iterates until
     the task is done, showing each tool call as it happens. bash runs
     through the shell itself, so the agent can use builtins, .js
     commands and wasm binaries. Works in the browser (CORS) and the
     CLI. Default provider is OpenRouter (BYOK: $LLM_API_KEY or
     ~/.config/llm.key). Browser keys are visible to page visitors —
     personal use only.

OPTIONS
     -m, --model=MODEL     model id (default openai/gpt-4o-mini)
     --base=URL            API base URL (local models: --base http://localhost:11434/v1)
     --plain               single completion, no tools
     -s, --steps=N         max agent steps (default 25)
     --list                list models (no key needed)
     -h, --help            help

EXAMPLES
     llm 'fix the bug in main.js'
     llm 'write a script that lists files by size'
     llm --plain 'what is 2+2'

SEE ALSO
     time, watch
`,
  time: `NAME
     time — run a command and report how long it took

SYNOPSIS
     time [-p] <command> [args...]

DESCRIPTION
     time runs the given command line through the shell and reports
     the elapsed wall-clock time (real), plus user/system CPU time in
     the Node CLI (the command runs in-process, so the process CPU
     counters cover it). The command's own output is passed through
     and its exit status becomes time's exit status.

OPTIONS
     -p, --portable   POSIX-style output (real 0.01 / user 0.00 ...)
     -h, --help       show help

EXAMPLES
     time ls /github
     time bash -c 'echo hi'
     time -p sleep 0.5

SEE ALSO
     /dev/time (current time device)
`,
  diff: `NAME
     diff — compare two files

SYNOPSIS
     diff <file1> <file2>

DESCRIPTION
     diff compares two files and prints the differences prefixed like
     a unified diff (space = context, - = removed, + = added). The
     engine is wasm-diff — the diff Rust crate compiled to WebAssembly
     and vendored at wasm-bin/wasm-diff.wasm (from the npm package
     wasm-diff; it's a wasm-bindgen library, so the command drives it
     directly). It diffs at character granularity, so intra-line
     changes appear as fine insert/delete chunks.

     Exit status: 0 if identical, 1 if different, 2 on error (like
     the real diff).

EXAMPLES
     diff /home/a.txt /home/b.txt
     diff README.md README.md.bak

SEE ALSO
     wasmer, grep
`,
  cowsay: `NAME
     cowsay — a talking cow (and friends)

SYNOPSIS
     cowsay [-f ANIMAL] [message...]
     echo message | cowsay

DESCRIPTION
     cowsay renders a message in a speech bubble spoken by an ASCII
     animal. Long messages wrap at 40 columns; a piped message works
     too. The default animal is a cow; -f picks another.

OPTIONS
     -f, --file ANIMAL   cow (default), tux, dragon
     -h, --help          show help

EXAMPLES
     cowsay moo
     cowsay -f tux hello
     echo 'feeling lucky' | cowsay -f dragon

SEE ALSO
     figlet, fortune
`,
  fortune: `NAME
     fortune — print a random quotation

SYNOPSIS
     fortune [-s]

DESCRIPTION
     fortune prints a random quote, proverb or joke from its built-in
     collection. -s (short) picks from the one-liners only.

OPTIONS
     -s, --short   only short quotes
     -h, --help    show help

EXAMPLES
     fortune
     cowsay "$(fortune -s)"

SEE ALSO
     cowsay
`,
  figlet: `NAME
     figlet — big ASCII banner text

SYNOPSIS
     figlet [-f FONT] [-s ROWS] [-b|-i|-n] <text...>
     figlet -l

DESCRIPTION
     figlet renders text as a large ASCII banner. In the browser it
     draws the text with a real font on a hidden canvas and samples
     the pixels into the banner; in the Node CLI it uses the built-in
     block font. -l lists fonts, styles and sizes.

OPTIONS
     -f, --font NAME    blocks, mono, serif, sans, cursive, fantasy,
                        courier, times, arial, impact (canvas fonts
                        need a browser)
     -s, --size ROWS    banner height 3..30 (canvas; default 8)
     -b, --bold         bold (canvas)
     -i, --italic       italic (canvas; combine with -b)
     -n, --normal       normal style (default)
     -l, --list         list fonts, styles and sizes
     -h, --help         show help

EXAMPLES
     figlet hello
     figlet -f impact -b j.cmd
     figlet -l

SEE ALSO
     cowsay
`,
  sl: `NAME
     sl — steam locomotive (the ls typo)

SYNOPSIS
     sl

DESCRIPTION
     In the browser a steam locomotive drives across the screen; press
     any key, click, or wait for it to pass. In the Node CLI the
     locomotive is printed statically.

EXAMPLES
     sl        (next time you mean ls)

SEE ALSO
     ls
`,
  cmatrix: `NAME
     cmatrix — Matrix-style digital rain

SYNOPSIS
     cmatrix

DESCRIPTION
     In the browser, green katakana rain falls down the screen
     (canvas-based, like the classic cmatrix); press any key, click,
     or wait ~15s to leave. In the Node CLI a static rain frame is
     printed.

EXAMPLES
     cmatrix

SEE ALSO
     xeyes, sl
`,
  at: `NAME
     at — run a command once, later

SYNOPSIS
     at <when> <command...>
     at -l | -r ID | -h

DESCRIPTION
     at schedules a one-shot job: the command runs through the shell
     at the given time and its output appears in the terminal. Jobs
     are session-scoped (like real at's queue) — they do not survive
     a page reload.

OPTIONS
     <when>       now | +Ns | +Nm | +Nh | +Nd | HH:MM (HH:MM today,
                  or tomorrow if already past)
     -l, --list   list pending jobs
     -r, --remove remove a job by id
     -h, --help   show help

EXAMPLES
     at +10s echo done
     at 14:30 echo lunch

SEE ALSO
     cron
`,
  cron: `NAME
     cron — periodic jobs

SYNOPSIS
     cron add "SCHEDULE" <command...>
     cron list | -l | rm ID | clear | -h

DESCRIPTION
     cron runs commands on a schedule, like the classic crontab. Jobs
     persist in /home/.tinyshcron and are re-armed when the shell
     starts, so they survive reloads. The scheduler ticks every 30s
     and runs each due job through the shell.

SCHEDULE
     min hour dom mon dow   five fields, space separated.
     * every value · */N every N · N-M a range · A,B a list.
     dow: 0 or 7 = Sunday.
     Examples: * * * * * (every minute), */5 * * * * (every 5 min),
               0 9 * * 1-5 (weekdays 09:00)

EXAMPLES
     cron add "*/5 * * * *" echo tick
     cron list · cron rm c1 · cron clear

SEE ALSO
     at
`,
  curl: `NAME
     curl — transfer data from URLs

SYNOPSIS
     curl [-o FILE] [-I] [-s] URL

DESCRIPTION
     curl fetches a URL with the browser/Node fetch API. Without -o
     the body is printed; -o saves it binary-safe. CORS applies in
     the browser (same as the /http mount).

OPTIONS
     -o FILE    save the response body to FILE
     -I, --head show headers only
     -s, --silent  no progress line
     -h, --help show help

EXAMPLES
     curl https://example.com
     curl -o /home/logo.png https://example.com/logo.png
`,
  gzip: `NAME
     gzip — compress files (gzip format)

SYNOPSIS
     gzip [-d] [-k] file...

DESCRIPTION
     gzip compresses each file to <file>.gz and removes the original
     (like real gzip); -k keeps it. -d decompresses. Engine: pako in
     the browser, node:zlib in the CLI. Binary safe.

OPTIONS
     -d, --decompress  decompress
     -k, --keep        keep the input
     -h, --help        show help

EXAMPLES
     gzip /home/notes.txt · gzip -d /home/notes.txt.gz
`,
  zstd: `NAME
     zstd — compress or decompress with Zstandard (real CLI)

SYNOPSIS
     zstd [-d] [-k] [-f] [-#] [file...]
     zstd -d file.zst

DESCRIPTION
     zstd is the real Zstandard CLI (facebook/zstd) compiled to
     wasm32-wasi. With no file arguments it reads stdin and writes
     the compressed stream to stdout, so pipes round-trip:
     'echo hi | zstd | zstd -d'. With file arguments it writes
     <file>.zst (like real zstd it keeps the source unless --rm).

OPTIONS
     -d, --decompress  decompress
     -k, --keep        keep the source file (default)
     --rm              delete the source after success (gzip-like)
     -f, --force       overwrite outputs without asking
     -#                compression level 1-19 (-3 is a good default)
     -o <file>         write output to <file>
     --version         print version

EXAMPLES
     echo hi | zstd | zstd -d     round-trip through a pipe
     zstd -f /home/notes.txt      compress a file
     zstd -d -f /home/notes.txt.zst   decompress a file
`,
  gunzip: `NAME
     gunzip — decompress gzip files

SYNOPSIS
     gunzip [-k] file.gz...

DESCRIPTION
     gunzip decompresses each <file>.gz back to <file> and removes
     the archive; -k keeps it. Engine: pako in the browser,
     node:zlib in the CLI.

EXAMPLES
     gunzip /home/notes.txt.gz
`,
  md5sum: `NAME
     md5sum — compute MD5 checksums

SYNOPSIS
     md5sum [file...]

DESCRIPTION
     Prints the MD5 digest of each file (or stdin when no files), in
     "hash  filename" form. Uses a bundled pure-JS MD5 so it works
     identically in the browser and the CLI.

EXAMPLES
     md5sum /home/hello.txt
`,
  sha256sum: `NAME
     sha256sum — compute SHA-256 checksums

SYNOPSIS
     sha256sum [file...]

DESCRIPTION
     Prints the SHA-256 digest of each file (or stdin when no files),
     in "hash  filename" form. Uses the Web Crypto API.

EXAMPLES
     sha256sum /home/hello.txt
`,
  tar: `NAME
     tar — create, list and extract tar archives

SYNOPSIS
     tar -cf ARCHIVE file... · tar -tf ARCHIVE · tar -xf ARCHIVE [-C DIR] [-z]

DESCRIPTION
     tar packs files and directories into a POSIX ustar archive.
     Directories are recursed; remote/device mounts (/pc /dev /proc
     /http /github /gitlab /git /mount) are skipped when walking.
     -z gzips the archive. Writing to /pc STREAMS the download
     through StreamSaver — nothing is materialized in memory.

EXAMPLES
     tar -cf /home/backup.tar /home/notes.txt
     tar -czf /pc/backup.tgz /          (streams the download)
     tar -xf /home/backup.tar -C /tmp
`,
  tree: `NAME
     tree — recursive directory listing

SYNOPSIS
     tree [dir] [-L N] [-a]

DESCRIPTION
     Prints the directory tree under [dir] (default cwd) with branch
     characters like the classic tree command.

OPTIONS
     -L N     descend at most N levels
     -a       include hidden files
     -h       show help

EXAMPLES
     tree /home · tree -L 2 /tmp
`,
  uptime: `NAME
     uptime — how long the shell has been running

SYNOPSIS
     uptime

DESCRIPTION
     Prints the current time, how long the shell has been up (since
     the page loaded, or since the process started), the current
     user, and a load average (not tracked, reads 0.00).
`,
  zip: `NAME
     zip — package files into a ZIP archive

SYNOPSIS
     zip <archive.zip> <file|dir>... · zip -l <archive.zip> · zip -x <archive.zip>

DESCRIPTION
     zip builds a standard ZIP archive (deflate, stored fallback).
     Directories are recursed. Engine: pako in the browser,
     node:zlib in the CLI. Binary safe.

EXAMPLES
     zip /home/backup.zip /home/notes.txt /home/photos/
     zip -x /home/backup.zip
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

  go: `NAME
     go — run or build Go programs with the real Go toolchain

SYNOPSIS
     go run <main.go> [args...]
     go build <main.go>
     go version
     go help

DESCRIPTION
     go runs the REAL Go compiler and linker — cmd/compile (go.wasm,
     37MB) and cmd/link (link.wasm, 8.9MB) — cross-compiled to
     GOOS=js GOARCH=wasm and executed in the browser via Go's
     wasm_exec.js glue (build-wasm-go.sh). JavaScript wasm modules
     built with GOOS=js GOARCH=wasm run as commands too: Go's os
     package maps to the shell's VirtualFS through a node-fs-style
     shim, and net/http maps to the browser fetch API.

     go run compiles the program to /tmp/go-build/, links it, and
     runs it. go build leaves <main>.wasm in the current directory,
     which can then be executed as ./<main>.wasm.

     Imports are limited to the bundled js_wasm stdlib: fmt, os,
     strings, strconv, math, time, sort, encoding/json, net/http
     plus their transitive dependencies.

OPTIONS
     (none — go is a builtin, not the cmd/go driver; js/wasm has
     no os/exec, so the driver is the shell command itself)

EXAMPLES
     go run hello.go
     go run server.go 8080
     go build tool.go
     ./tool.wasm

SEE ALSO
     wasmer, cc, help
`,

  nethack: `NAME
     nethack — play NetHack 3.6.7, the real game compiled to WASM

SYNOPSIS
     nethack              (browser: full-screen TTY game)
     nethack --demo       (CLI: headless autoplay)
     nethack help

DESCRIPTION
     nethack runs the ACTUAL NetHack 3.6.7 — the 1980s roguelike —
     compiled to WebAssembly with emscripten (apowers313/NetHackJS →
     the neth4ck monorepo; the game data is embedded in the wasm).
     The C game drives a single async window-system callback
     (Asyncify), which this shell renders as a TTY: status line on
     top, the dungeon map in the middle, messages at the bottom.

     In the browser the game takes over the screen; keys go straight
     to NetHack. ESC followed by q quits (the tty meta-key), like a
     real terminal; Ctrl+C always returns to the shell.

     nethack --demo plays a scripted game headlessly — it proves the
     whole pipeline (window init, map glyphs, status, prompts, quit)
     works without a browser.

     Assets: www/vendor/nethack.{js,wasm} (the wasm is 4.9MB; the
     game data /nhdat is embedded). Fetch with build-wasm-nethack.sh
     from the @neth4ck/wasm-367 npm package.

EXAMPLES
     nethack                  # browser: start playing
     nethack --demo           # CLI: autoplay a scripted game

SEE ALSO
     wasmer, cc, go, help
`,

  jobs: `NAME
     jobs — list background jobs

SYNOPSIS
     jobs

DESCRIPTION
     Lists the shell's background jobs (\`cmd &\`): job id, pid, status
     and the command line. Status is running, done (0), failed (N) or
     killed (137). In the browser the same jobs appear in the right-hand
     panel, split vertically among the non-minimized jobs.

SEE ALSO
     wait, kill
`,

  wait: `NAME
     wait — wait for background jobs

SYNOPSIS
     wait [job-id | pid]

DESCRIPTION
     With no argument, waits for all background jobs and returns 0 if
     they all succeeded. With a job id or pid, waits for that job and
     returns its exit status (127 if no such job).

SEE ALSO
     jobs, kill
`,

  kill: `NAME
     kill — terminate a background job

SYNOPSIS
     kill <job-id | pid>

DESCRIPTION
     Terminates a running background job (exit 137, like SIGKILL — the
     pipeline is abandoned and its output discarded). For a finished
     job, kill dismisses it from the job table and the browser panel.
     In the browser the panel's ✕ button does the same.

SEE ALSO
     jobs, wait
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
    for (const dir of ["/bin", "/usr/bin", "/home/examples", "."]) {
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
        source: `/usr/bin/${name}.wasm`,
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
