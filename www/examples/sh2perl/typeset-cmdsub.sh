#!/usr/bin/env bash
# ============================================================================
# typeset-cmdsub.sh — Demonstration of the 'typeset' command (declare synonym)
# Used as a test case for the shell-to-Perl translator.
# Safe to run: no destructive operations, uses only hardcoded paths.
# ============================================================================

# --- typeset -i (integer attribute) -------------------------------------------
echo "=== typeset -i (integer attribute) ==="
unset n
typeset -i n=42
echo "After 'typeset -i n=42': n='$n'"
n=n+1
echo "After 'n=n+1':          n='$n' (integer arithmetic applied)"
n="hello"
echo "After 'n=\"hello\"':     n='$n' (assigns 0; non-numeric string becomes 0)"
echo

# --- typeset -r (readonly attribute) ------------------------------------------
echo "=== typeset -r (readonly attribute) ==="
unset rovar
typeset -r rovar="immutable"
echo "After 'typeset -r rovar=immutable': rovar='$rovar'"
echo "(Attempting 'rovar=change' would cause an error; skipped for safety.)"
echo

# --- typeset -l (lowercase attribute) -----------------------------------------
echo "=== typeset -l (lowercase attribute) ==="
unset lc
typeset -l lc="HELLO WORLD"
echo "After 'typeset -l lc=\"HELLO WORLD\"': lc='$lc'"
lc="ANOTHER TEST"
echo "After 'lc=\"ANOTHER TEST\"':           lc='$lc'"
echo

# --- typeset -u (uppercase attribute) -----------------------------------------
echo "=== typeset -u (uppercase attribute) ==="
unset uc
typeset -u uc="hello world"
echo "After 'typeset -u uc=\"hello world\"': uc='$uc'"
uc="another test"
echo "After 'uc=\"another test\"':            uc='$uc'"
echo

# --- typeset -x (export attribute) --------------------------------------------
echo "=== typeset -x (export attribute) ==="
unset myexport
typeset -x myexport="exported_value"
echo "After 'typeset -x myexport=exported_value'"
echo "Variable is exported:"
# Check env to confirm
env | grep '^myexport=' || echo "(myexport not found in env — possible scope issue)"
echo

# --- typeset -a (indexed array) -----------------------------------------------
echo "=== typeset -a (indexed array) ==="
unset arr
typeset -a arr=(10 20 30)
echo "After 'typeset -a arr=(10 20 30)': arr=(${arr[@]})"
echo "arr[0]='${arr[0]}' arr[1]='${arr[1]}' arr[2]='${arr[2]}'"
echo

# --- typeset -A (associative array) -------------------------------------------
echo "=== typeset -A (associative array) ==="
unset assoc
typeset -A assoc=([key1]=value1 [key2]=value2)
echo "After 'typeset -A assoc=([key1]=value1 [key2]=value2)'"
echo "assoc[key1]='${assoc[key1]}'  assoc[key2]='${assoc[key2]}'"
echo

# --- typeset -n (name reference / nameref) ------------------------------------
echo "=== typeset -n (name reference) ==="
unset original ref
original="I am the original"
typeset -n ref=original
echo "After 'typeset -n ref=original':"
echo "original='$original'"
echo "ref='$ref'"
ref="Changed via ref"
echo "After 'ref=\"Changed via ref\"':"
echo "original='$original'"
echo "ref='$ref'"
unset -n ref 2>/dev/null  # clean up the nameref
echo

# --- typeset -f (function display) --------------------------------------------
echo "=== typeset -f (display function definition) ==="
myfunc() {
    echo "Inside myfunc"
    local x=5
    echo "x=$x"
}
echo "Output of 'typeset -f myfunc':"
typeset -f myfunc
echo

# --- typeset -F (function names only, no body) --------------------------------
echo "=== typeset -F (list function names) ==="
typeset -F myfunc
echo

# --- typeset -g (inside function, declare global) -----------------------------
echo "=== typeset -g (global scope in function) ==="
set_global() {
    typeset -g global_var="I am global"
}
set_global
echo "After set_global(): global_var='$global_var'"
echo

# --- typeset -t (trace attribute) ---------------------------------------------
echo "=== typeset -t (trace attribute) ==="
typeset -t tracetest=traced
echo "After 'typeset -t tracetest=traced': (trace attribute set)"
echo "tracetest='$tracetest'"
echo

# --- typeset -p (print attributes) --------------------------------------------
echo "=== typeset -p (print attribute info) ==="
unset printtest
typeset -i printtest=99
typeset -r printtest
echo "After 'typeset -i -r printtest=99':"
typeset -p printtest
echo

# --- typeset with -i -l -u combinations ---------------------------------------
echo "=== combined: typeset -il (integer + lowercase) ==="
unset comb
typeset -il comb=42
echo "After 'typeset -il comb=42': comb='$comb' (integer + lowercase)"
comb=comb+1
echo "After 'comb=comb+1':    comb='$comb' (integer arithmetic active)"
echo

echo "=== combined: typeset -iu (integer + uppercase) ==="
unset comb2
typeset -iu comb2=99
echo "After 'typeset -iu comb2=99': comb2='$comb2' (integer + uppercase)"
comb2=comb2+1
echo "After 'comb2=comb2+1': comb2='$comb2' (integer arithmetic active)"
echo

# --- typeset -a with assignment -----------------------------------------------
echo "=== typeset -a (indexed array, individual element) ==="
unset singlearr
typeset -a singlearr
singlearr[0]="first"
singlearr[1]="second"
echo "singlearr[0]='${singlearr[0]}'  singlearr[1]='${singlearr[1]}'"
echo

# --- typeset default (no flag) = regular variable -----------------------------
echo "=== typeset (no flag) ==="
unset plain
typeset plain="just a string"
echo "After 'typeset plain=\"just a string\"': plain='$plain'"
echo

echo "=== Demonstration complete. ==="
