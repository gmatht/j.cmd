#include <cstdio>
int main() {
    int x = 5;
    int& r = x;
    r = 6;
    printf("%d\n", x);
    return 0;
}
