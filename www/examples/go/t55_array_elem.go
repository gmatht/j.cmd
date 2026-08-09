// t55_array_elem: slice element write
// diagnostics: program prints its result to stdout
a := []string{"a", "b", "c"}
a[1] = "X"
fmt.Println(a[0] + " " + a[1] + " " + a[2])
