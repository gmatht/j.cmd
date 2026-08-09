// t54_map: map literal + index read (otranspiler's extension tables)
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (map literals).
m := map[string]string{"c": "C", "go": "Go"}
fmt.Println(m["go"])
