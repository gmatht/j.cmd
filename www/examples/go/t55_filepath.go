// t55_filepath: filepath ops (otranspiler's workspace root)
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (path/filepath).
fmt.Println(filepath.Dir("/a/b/c"))
fmt.Println(filepath.Ext("main.go"))
