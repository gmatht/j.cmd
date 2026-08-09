// t34_cmdsub: command substitution
// diagnostics: program prints its result to stdout
x, _ := exec.Command("echo", "hi").Output()
fmt.Print(string(x))
