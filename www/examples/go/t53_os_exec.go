// t53_os_exec: constructing an os/exec command (otranspiler's core dispatch)
// diagnostics: program prints its result to stdout
// DRIVER: frontend emit gap (os/exec + struct field access).
c := exec.Command("echo", "hi")
fmt.Println(c.Args)
