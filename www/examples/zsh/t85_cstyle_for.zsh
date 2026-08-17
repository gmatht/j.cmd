# t85_cstyle_for: C-style for loop with arithmetic header (A1 ForInit)
# diagnostics: program prints its result to stdout
for ((i=0; i<3; i++)); do
    echo "i=$i"
done
sum=0
for ((j=1; j<=5; j+=2)); do
    sum=$((sum + j))
done
echo "sum=$sum"
