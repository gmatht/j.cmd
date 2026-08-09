// t66_array_slice: slice slice
// diagnostics: program prints its result to stdout
a := []string{"a", "b", "c", "d"}
fmt.Println(strings.Join(a[1:3], " "))
