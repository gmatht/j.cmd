// t48_accum: accumulate a sum in a loop
// diagnostics: program prints its result to stdout
s := 0
for _, n := range []int{1, 2, 3} {
    s += n
}
fmt.Println(s)
