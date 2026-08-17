// t76_import: import statement (official Go grammar importDecl/importSpec)
// diagnostics: program prints its result to stdout
package main
import "fmt"
func main() {
    fmt.Println("imported")
    x := 3
    fmt.Println(x)
}
