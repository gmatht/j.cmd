#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# factor.sh — prime factorization by trial division (the GPU-lift case
# study). The CPU baseline for the shader-lift benchmark: run it with
# `bash factor.sh <n>` (or `./factor.sh <n>`), and compare against the
# C twin (www/examples/c/factor.c) and the shader-lift patterns
# (__factor-bench.mjs).
#
# Why this program is the case study: the trial-division loop is the
# compute core, and it is SEQUENTIAL (n is mutated across iterations),
# so the whole program is NOT liftable to a shader as written — the
# detector (sh2glsl --check / --auto) reports argv, exit, regex !,
# array append and [ ] tests as unsupported. The lift requires
# exposing the parallel dimension: one pixel per number (batch) or one
# pixel per divisor candidate (sieve) — see WRITING_GPU_SHADERS_IN_BASH.md
# §6c and __factor-bench.mjs for the two restructured patterns.
#
#   bash factor.sh 360        → Prime factors of 360: 2 2 2 3 3 5
#   bash factor.sh 2147483647 → 2147483647 is a prime number, not a composite number.
# ─────────────────────────────────────────────────────────────────────

# Check if a number was provided as an argument
if [ -z "$1" ]; then
    echo "Usage: $0 <number>"
    exit 1
fi

n=$1

# Validate input: Must be an integer greater than 1
if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -le 1 ]; then
    echo "Error: Please provide a composite integer greater than 1."
    exit 1
fi

original_n=$n
factors=()
d=2

# Trial division loop
while [ $((d * d)) -le "$n" ]; do
    # While d divides n, add d to factors and divide n
    while [ $((n % d)) -eq 0 ]; do
        factors+=("$d")
        n=$((n / d))
    done
    d=$((d + 1))
done

# If n is still greater than 1, then it is a prime factor itself
if [ "$n" -gt 1 ]; then
    factors+=("$n")
fi

# Output the results
if [ "${#factors[@]}" -eq 1 ] && [ "${factors[0]}" -eq "$original_n" ]; then
    echo "$original_n is a prime number, not a composite number."
else
    echo "Prime factors of $original_n: ${factors[*]}"
fi
