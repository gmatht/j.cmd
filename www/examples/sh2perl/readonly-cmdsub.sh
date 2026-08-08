#!/usr/bin/env bash
# ============================================================================
# readonly-cmdsub.sh
# -----------------
# Minimal self-contained demo of the bash 'readonly' builtin.
#
# This script is designed to be safe (no rm -rf, no destructive ops).
# It is used as a test case for the shell-to-Perl translator.
#
# Each section prints debug-like output to show what the command returns.
# ============================================================================

set -u  # treat unset variables as an error
# Don't set -e because we intentionally test failures.

RC=0  # cumulative exit code (0 = all tests passed)

# --------------------------------------------------------------------------
# Helper: run a command and capture its stdout, stderr and exit code.
# We use a filesystem-based capture because we're bash and want to be
# compatible even with a simple shell.
# --------------------------------------------------------------------------
capture() {
    local label="$1"
    shift
    local tmp_stdout tmp_stderr
    tmp_stdout=$(mktemp /tmp/readonly_demo_stdout_XXXXXX)
    tmp_stderr=$(mktemp /tmp/readonly_demo_stderr_XXXXXX)
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
    fi
    if [[ -n "${se}" ]]; then
        echo "  stderr  : ${se}"
    fi
    echo ""
    return ${ec}
}

# ============================================================================
# 1. Basic readonly variable
# ============================================================================
echo "============================================================"
echo " SECTION 1: Basic readonly variable"
echo "============================================================"
capture "01-readonly-var" \
    bash -c '
        readonly MY_VAR="hello_world"
        echo "MY_VAR=${MY_VAR}"
        # Attempt to change it (will fail, but we capture)
        MY_VAR="changed" 2>/dev/null || echo "Assignment denied: $?"
        echo "MY_VAR after attempted change=${MY_VAR}"
    '

# --------------------------------------------------------------------------
# 2. readonly -p  (print list of all readonly variables)
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 2: readonly -p  (print readonly variables)"
echo "============================================================"
# We run in a subshell so we don't pollute the outer shell.
capture "02-readonly-p" \
    bash -c '
        readonly FOO=alpha
        readonly BAR=beta
        readonly -p | head -5
    '

# --------------------------------------------------------------------------
# 3. readonly -f  (mark functions as readonly)
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 3: readonly -f  (readonly functions)"
echo "============================================================"
capture "03-readonly-f" \
    bash -c '
        myfunc() { echo "Hello from myfunc"; }
        readonly -f myfunc
        myfunc
        # Attempt to unset the function (will fail)
        unset -f myfunc 2>/dev/null || echo "unset -f denied"
        # Verify function still exists
        myfunc
    '

# --------------------------------------------------------------------------
# 4. readonly -a  (indexed array variable)
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 4: readonly -a  (indexed array)"
echo "============================================================"
capture "04-readonly-a" \
    bash -c '
        declare -a MY_ARR=(zero one two)
        readonly -a MY_ARR
        echo "MY_ARR[0]=${MY_ARR[0]}"
        echo "MY_ARR[1]=${MY_ARR[1]}"
        # Attempt to change an element (will fail)
        MY_ARR[0]=ZERO 2>/dev/null || echo "Array assignment denied"
        echo "MY_ARR[0] after attempt=${MY_ARR[0]}"
    '

# --------------------------------------------------------------------------
# 5. readonly -A  (associative array)  -- bash 4.0+
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 5: readonly -A  (associative array)"
echo "============================================================"
capture "05-readonly-A" \
    bash -c '
        declare -A MY_ASSOC=([key1]=val1 [key2]=val2)
        readonly -A MY_ASSOC
        echo "MY_ASSOC[key1]=${MY_ASSOC[key1]}"
        echo "MY_ASSOC[key2]=${MY_ASSOC[key2]}"
        # Attempt to change (will fail)
        MY_ASSOC[key1]=CHANGED 2>/dev/null || echo "Assoc assignment denied"
        echo "MY_ASSOC[key1] after attempt=${MY_ASSOC[key1]}"
    '

# --------------------------------------------------------------------------
# 6. readonly --  (disable further option processing)
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 6: readonly --  (no more options)"
echo "============================================================"
# The -- separator ensures that subsequent arguments are treated as
# names, not options.  We show two scenarios:
#   (a) readonly -- normal_var=val   works as expected
#   (b) readonly -- -invalid   fails with "not a valid identifier"
#       (the -- prevents -invalid from being interpreted as an option)
capture "06a-readonly-dash-ok" \
    bash -c '
        readonly -- MYVAR=hello
        echo "MYVAR=${MYVAR}"
        # Confirm it is indeed readonly
        MYVAR=world 2>/dev/null || echo "Assignment denied (expected)"
    '

capture "06b-readonly-dash-invalid" \
    bash -c '
        readonly -- -notvalid 2>&1 || true
    '

# --------------------------------------------------------------------------
# 7. Failure: readonly on an invalid name
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 7: Invalid variable name (error case)"
echo "============================================================"
capture "07-invalid-name" \
    bash -c '
        readonly 123invalid 2>&1 || true
    '

# --------------------------------------------------------------------------
# 8. readonly -p with functions  (readonly -f -p)
# --------------------------------------------------------------------------
echo "============================================================"
echo " SECTION 8: readonly -f -p  (list readonly functions)"
echo "============================================================"
capture "08-readonly-f-p" \
    bash -c '
        f1() { :; }
        f2() { :; }
        readonly -f f1 f2
        readonly -f -p | head -5
    '

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "All readonly demo sections completed."
exit ${RC}
