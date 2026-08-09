#include <stdio.h>
struct Point {
    int x;
    int y;
};
int main(void) {
    struct Point p;
    p.x = 3;
    p.y = 4;
    printf("%d %d %d\n", p.x, p.y, sizeof(p));
    return 0;
}
