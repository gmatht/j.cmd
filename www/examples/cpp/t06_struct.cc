#include <cstdio>
struct Point {
    int x;
    int y;
};
int main() {
    struct Point p;
    p.x = 3;
    p.y = 4;
    printf("%d %d\n", p.x, p.y);
    return 0;
}
