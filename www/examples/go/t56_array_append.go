// t56_array_append: slice append
// diagnostics: program prints its result to stdout
a := []string{"a", "b"}
a = append(a, "c", "d")
fmt.Println(a[0] + "|" + a[1] + "|" + a[2] + "|" + a[3])
