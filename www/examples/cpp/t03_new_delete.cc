#include <cstdio>
#include <cstdlib>
int main() {
    int* a = new int[3];
    a[0] = 10;
    a[1] = 20;
    a[2] = 30;
    int* p = a + 1;
    printf("%d %d %d\n", *p, p[1], a[0]);
    delete[] a;
    int* s = new int;
    *s = 7;
    printf("%d\n", *s);
    delete s;
    return 0;
}
