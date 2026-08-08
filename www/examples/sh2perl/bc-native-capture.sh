#!/bin/bash
# bc native capture (Plan 8 — SH2_BC_NATIVE, default ON): `$(echo EXPR | bc)`
# capture pipelines lower to a compile-time fold (static EXPR), a native
# sqrt-of-var expression, or native var-operand arithmetic (`$sum + $i` —
# bc scale-0 integer semantics over doubles) — no spawn. The corpus
# oracle gates the subset (src/bc.rs matches real GNU bc 77/77);
# SH2_BC_NATIVE=0 restores the spawn.

echo "2+3" | bc
echo "scale=2; 5/2" | bc
echo "2^10" | bc
echo "7 % 3" | bc
echo "-2^2" | bc
echo "0.5+0.25" | bc
echo "sqrt(25)" | bc

for n in 4 9 16 25 100; do
    echo "sqrt($n) = $(echo "sqrt($n)" | bc)"
done

sum=0
for i in 1 2 3 4 5; do
    sum=$(echo "$sum + $i" | bc)
done
echo "sum=$sum"
