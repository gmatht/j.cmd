#!/usr/bin/env bash
# ============================================================================
# tty-cmdsub.sh
# -------------
# Minimal self-contained demo of the GNU coreutils 'tty' command.
#
# This script is designed to be safe (no rm -rf, no destructive ops).
# It is used as a test case for the shell-to-Perl translator.
#
# Each section prints debug-like output to show what the command returns.
#
# Options deliberately excluded: --version, --help (and anything that goes
# exclusively to stderr is handled but not the focus).
# ============================================================================

set -u  # treat unset variables as an error

# --------------------------------------------------------------------------
# Helper: run a command and capture its stdout, stderr and exit code.
# --------------------------------------------------------------------------
capture() {
    local label="$1"
    shift
    local tmp_stdout tmp_stderr
    tmp_stdout=$(mktemp /tmp/tty_demo_stdout_XXXXXX)
    tmp_stderr=$(mktemp /tmp/tty_demo_stderr_XXXXXX)
    # Run the command, saving both streams.
    "$@" >"$tmp_stdout" 2>"$tmp_stderr"
    local ec=$?
    local so
    so=$(cat "$tmp_stdout")
    local se
    se=$(cat "$tmp_stderr")
    rm -f "$tmp_stdout" "$tmp_stderr"
    echo "--- [${label}] ---"
    echo "  cmd     : $*"
    echo "  exitcode: ${ec}"
    if [[ -n "${so}" ]]; then
        echo "  stdout  : ${so}"
    else
        echo "  stdout  : (empty)"
    fi
    if [[ -n "${se}" ]]; then
        echo "  stderr  : ${se}"
    fi
    echo ""
    return ${ec}
}

# Determine a terminal device that is readable by the current process.
# We use /dev/pts/2, /dev/pts/3, /dev/pts/4 (owned by user 'ai' on this system).
# Fall back to the first readable pts.
TTY_DEV=""
for dev in /dev/pts/2 /dev/pts/3 /dev/pts/4; do
    if [[ -r "$dev" ]]; then
        TTY_DEV="$dev"
        break
    fi
done
if [[ -z "$TTY_DEV" ]]; then
    # Last resort: pick any readable pts or tty
    for dev in /dev/pts/*; do
        if [[ -r "$dev" ]]; then
            TTY_DEV="$dev"
            break
        fi
    done
fi

echo "Using terminal device: ${TTY_DEV:-NONE}"
echo ""

# ============================================================================
# 1. Default 'tty' with a real terminal (stdin redirected from TTY_DEV)
#    Expect: prints the terminal device name, exit code 0
# ============================================================================
echo "============================================================"
echo " SECTION 1: tty (default) — with a real terminal"
echo "============================================================"
if [[ -n "$TTY_DEV" ]]; then
    capture "01-default-terminal" tty < "$TTY_DEV"
else
    echo "  (skipped — no terminal device available)"
    echo ""
fi

# ============================================================================
# 2. Default 'tty' with /dev/null (not a terminal)
#    Expect: prints "not a tty", exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 2: tty (default) — stdin from /dev/null"
echo "============================================================"
capture "02-not-a-tty" tty < /dev/null

# ============================================================================
# 3. Default 'tty' with piped input (not a terminal)
#    Expect: prints "not a tty", exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 3: tty (default) — piped input"
echo "============================================================"
capture "03-pipe-notty" bash -c 'echo "dummy" | tty'

# ============================================================================
# 4. 'tty -s' (silent) with a real terminal
#    Expect: no output, exit code 0
# ============================================================================
echo "============================================================"
echo " SECTION 4: tty -s — with a real terminal (silent)"
echo "============================================================"
if [[ -n "$TTY_DEV" ]]; then
    capture "04-silent-terminal" tty -s < "$TTY_DEV"
else
    echo "  (skipped — no terminal device available)"
    echo ""
fi

# ============================================================================
# 5. 'tty -s' with /dev/null (not a terminal)
#    Expect: no output, exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 5: tty -s — stdin from /dev/null (silent, not a tty)"
echo "============================================================"
capture "05-silent-notty" tty -s < /dev/null

# ============================================================================
# 6. 'tty -s' with piped input (not a terminal)
#    Expect: no output, exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 6: tty -s — piped input (silent, not a tty)"
echo "============================================================"
capture "06-silent-pipe" bash -c 'echo "dummy" | tty -s'

# ============================================================================
# 7. 'tty --silent' (long form) with a real terminal
#    Expect: no output, exit code 0
# ============================================================================
echo "============================================================"
echo " SECTION 7: tty --silent — long form, with a real terminal"
echo "============================================================"
if [[ -n "$TTY_DEV" ]]; then
    capture "07-long-silent" tty --silent < "$TTY_DEV"
else
    echo "  (skipped — no terminal device available)"
    echo ""
fi

# ============================================================================
# 8. 'tty --quiet' (alternative long form) with a real terminal
#    Expect: no output, exit code 0
# ============================================================================
echo "============================================================"
echo " SECTION 8: tty --quiet — long form, with a real terminal"
echo "============================================================"
if [[ -n "$TTY_DEV" ]]; then
    capture "08-long-quiet" tty --quiet < "$TTY_DEV"
else
    echo "  (skipped — no terminal device available)"
    echo ""
fi

# ============================================================================
# 9. 'tty --silent' with /dev/null (not a terminal)
#    Expect: no output, exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 9: tty --silent — stdin from /dev/null (not a tty)"
echo "============================================================"
capture "09-long-silent-notty" tty --silent < /dev/null

# ============================================================================
# 10. 'tty --quiet' with /dev/null (not a terminal)
#     Expect: no output, exit code 1
# ============================================================================
echo "============================================================"
echo " SECTION 10: tty --quiet — stdin from /dev/null (not a tty)"
echo "============================================================"
capture "10-long-quiet-notty" tty --quiet < /dev/null

# ============================================================================
# 11. 'tty' without any stdin redirect (inherits stdin from the script)
#     The script itself runs with whatever stdin the caller provided.
#     We capture this as-is.
# ============================================================================
echo "============================================================"
echo " SECTION 11: tty (default) — inheriting stdin from the script"
echo "============================================================"
capture "11-inherited" tty

# ============================================================================
# 12. 'tty -s' without any stdin redirect
# ============================================================================
echo "============================================================"
echo " SECTION 12: tty -s — inheriting stdin from the script"
echo "============================================================"
capture "12-inherited-silent" tty -s

# ============================================================================
# 13. 'tty -s -s' — repeated -s flag (should be harmless)
# ============================================================================
echo "============================================================"
echo " SECTION 13: tty -s -s — repeated silent flag"
echo "============================================================"
if [[ -n "$TTY_DEV" ]]; then
    capture "13-double-silent" tty -s -s < "$TTY_DEV"
else
    echo "  (skipped — no terminal device available)"
    echo ""
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "All tty demo sections completed."
