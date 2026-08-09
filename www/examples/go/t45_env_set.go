// t45_env_set: set an environment variable
// diagnostics: program prints its result to stdout
os.Setenv("X", "v")
fmt.Println(os.Getenv("X"))
