// t28_sizeof: sizeof of builtin types, a typed variable, and a struct
// diagnostics: program prints its result to stdout
#include <cstdio>
struct Point {
    int x;
    int y;
};
int main() {
    long long ll = 5;
    struct Point p;
    printf("%d %d %d %d\n", sizeof(char), sizeof(int), sizeof(long long), sizeof(double));
    printf("%d %d\n", sizeof(ll), sizeof(p));
    return 0;
}
