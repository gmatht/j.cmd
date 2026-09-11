package main

import "fmt"

func get() string { return "v" }

func main() {
	m := map[string]any{"a": get(), "b": "x"}
	fmt.Println(m["a"], m["b"])
}
