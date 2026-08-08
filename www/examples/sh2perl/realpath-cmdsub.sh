#!/bin/bash
# realpath-cmdsub.sh — demonstrate coreutils realpath(1) for shell→Perl translator test
#
# Self-contained; uses only files/symlinks that exist on a standard Debian Bookworm
# aarch64 system.  Safe to run (no destructive operations).
#
# Each test prints a description, the command line, then the captured output.

set -o nounset

# ---------------------------------------------------------------------------
# Helper — print a header, run the command, show exit code and result
# ---------------------------------------------------------------------------
try () {
    local desc="$1"       # human‑readable label
    shift
    local cmd=("$@")      # command array

    echo "==== $desc ===="

    # Show the command we're about to run (quote arguments for readability)
    printf '  $ '
    for arg in "${cmd[@]}"; do
        if [[ "$arg" =~ [[:space:]] ]]; then
            printf "'%s' " "$arg"
        else
            printf '%s ' "$arg"
        fi
    done
    echo

    # Capture stdout and stderr separately
    local stdout stderr rc
    stdout=$("${cmd[@]}" 2>/tmp/realpath_stderr.$$)
    rc=$?
    stderr=$(cat /tmp/realpath_stderr.$$ 2>/dev/null || true)
    rm -f /tmp/realpath_stderr.$$

    # Show results
    if [[ -n "$stdout" ]]; then
        # For -z/--zero we need to display NUL bytes
        if [[ "$stdout" == *$'\x00'* ]]; then
            printf '  stdout (NUL‑terminated): '
            printf '%s' "$stdout" | od -A n -t x1z
            printf '\n'
        else
            printf '  stdout: %s\n' "$stdout"
        fi
    else
        printf '  stdout: (empty)\n'
    fi

    if [[ -n "$stderr" ]]; then
        printf '  stderr: %s\n' "$stderr"
    fi
    printf '  exit code: %d\n\n' "$rc"
}

# ===================================================================
# 1.  BASIC USAGE — no options
#     Resolves all symlinks in the path (default is --physical)
# ===================================================================

try 'realpath (default, --physical) on a simple file' \
    realpath /bin

try 'realpath on a two‑hop symlink chain: /usr/bin/vi → /etc/alternatives/vi → /usr/bin/vim.basic' \
    realpath /usr/bin/vi

try 'realpath on a relative symlink: /usr/local/bin/pi' \
    realpath /usr/local/bin/pi

try 'realpath on a regular file (no symlinks)' \
    realpath /etc/hostname

try 'realpath on a directory with .. component' \
    realpath /tmp/..

# ===================================================================
# 2.  -e / --canonicalize-existing
#     All path components must exist.  (Default behaviour for realpath,
#     but it is an error if any component is missing.)
# ===================================================================

try '--canonicalize-existing on an existing path' \
    realpath --canonicalize-existing /usr/bin/sh

try '--canonicalize-existing on a path with a missing last component (should fail)' \
    realpath --canonicalize-existing /tmp/no_such_file_xyzzy || true

# ===================================================================
# 3.  -m / --canonicalize-missing
#     No path components need exist.
# ===================================================================

try '--canonicalize-missing on a path with a non‑existent leaf' \
    realpath --canonicalize-missing /tmp/no_such_file_xyzzy

try '--canonicalize-missing on a completely imaginary path' \
    realpath --canonicalize-missing /nonexistent/deeply/missing/file

try '--canonicalize-missing on a path with .. and non‑existent parts' \
    realpath --canonicalize-missing /tmp/../nonexistent/../foo

# ===================================================================
# 4.  -L / --logical
#     Resolve .. components before following symlinks.
# ===================================================================

try '--logical: /bin/..  (bin is a symlink, logical resolves .. before following it)' \
    realpath --logical /bin/..

try 'default (--physical) for comparison: /bin/..' \
    realpath --physical /bin/..

# ===================================================================
# 5.  -P / --physical  (default)
#     Resolve symlinks first, then .. components.
# ===================================================================

try '--physical: /bin/..  (explicit, same as default)' \
    realpath --physical /bin/..

# ===================================================================
# 6.  -s / --strip / --no-symlinks
#     Do not expand symlinks; just clean up the path.
# ===================================================================

try '--strip (no symlink expansion) on /usr/bin/vi' \
    realpath --strip /usr/bin/vi

try '--strip on /bin  (symlink /bin → usr/bin)' \
    realpath --strip /bin

try 'compare: default (--physical) on /bin' \
    realpath /bin

# ===================================================================
# 7.  --relative-to=DIR
#     Print the resolved path relative to DIR.
# ===================================================================

try '--relative-to=/usr/bin for /usr/bin/sh' \
    realpath --relative-to=/usr/bin /usr/bin/sh

try '--relative-to=/tmp for /etc/hostname' \
    realpath --relative-to=/tmp /etc/hostname

try '--relative-to=/ for /etc/hostname' \
    realpath --relative-to=/ /etc/hostname

# ===================================================================
# 8.  --relative-base=DIR
#     Print absolute paths unless paths are below DIR.
# ===================================================================

try '--relative-base=/etc for /etc/hostname (below /etc → relative)' \
    realpath --relative-base=/etc /etc/hostname

try '--relative-base=/etc for /usr/bin/sh (not below /etc → absolute)' \
    realpath --relative-base=/etc /usr/bin/sh

try '--relative-base=/ with --relative-to=/tmp  (combined)' \
    realpath --relative-base=/ --relative-to=/tmp /etc/hostname /usr/bin/sh

# ===================================================================
# 9.  -z / --zero
#     End each output line with NUL, not newline.
# ===================================================================

# --zero test: special case because bash command substitution strips NUL bytes.
# We run realpath directly without capturing via $().
echo '==== --zero with two paths ===='
printf '  $ realpath --zero /bin /usr/bin/sh\n'
realpath --zero /bin /usr/bin/sh; rc_zero=$?
# Show the raw output (NUL bytes will display as spaces or ^@ in terminal)
printf '  (raw output with NULs above; use od to verify):\n'
printf '  '; realpath --zero /bin /usr/bin/sh | od -A n -t x1z | head -3
printf '  exit code: %d\n\n' "$rc_zero"

# ===================================================================
# 10. -q / --quiet
#     Suppress most error messages (exit code still reflects failure).
# ===================================================================

# For --quiet we need a path where an *intermediate* component is missing
# so that realpath fails even in default mode.
try '--quiet suppresses error message for a truly invalid path' \
    realpath --quiet /nonexistent_dir_xyzzy/foo || true

try 'without --quiet for comparison (stderr appears)' \
    realpath /nonexistent_dir_xyzzy/foo || true

# ===================================================================
# Done
# ===================================================================
echo "=== All tests completed ==="
