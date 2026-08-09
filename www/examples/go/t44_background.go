// t44_background: background job and wait
// diagnostics: program prints its result to stdout
// `go func(){...}()` is racy (the goroutine may never run before main
// returns), so the deterministic Go idiom is Start + Wait — the exact
// analog of the posix pair `(echo bg) & wait; echo main`. Go children
// discard stdout unless wired up: `cmd.Stdout = os.Stdout` (a no-op in
// the lowering — shell commands inherit stdout by default).
cmd := exec.Command("echo", "bg")
cmd.Stdout = os.Stdout
cmd.Start()
cmd.Wait()
fmt.Println("main")
