// t32_redirect: redirect output to a file
// diagnostics: program prints its result to stdout
// Relative target: the gate runs native + transpiled sides in per-run
// scratch dirs, so an absolute path like /tmp/f would collide across
// users (a stale root-owned /tmp/f makes the transpiled writeFile throw
// EACCES while native Go discards the error — flaky DIFF).
os.WriteFile("f", []byte("data\n"), 0o644)
fmt.Println("wrote")
