package main

import (
	"encoding/json"
	"fmt"
)

func main() {
	out := make([]any, 2)
	out[0] = map[string]any{"name": "a"}
	out[1] = map[string]any{"name": "b"}
	fmt.Println(len(out))
	m0 := out[0].(map[string]any)
	fmt.Println(m0["name"])
	m1, ok := out[1].(map[string]any)
	fmt.Println(ok, m1["name"])
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
