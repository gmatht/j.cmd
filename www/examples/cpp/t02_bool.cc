#include <cstdio>
int main() {
    bool ok = true;
    bool no = false;
    if (ok == 1) printf("yes\n");
    if (no == 0) printf("not no\n");
    if (!(no == 1)) printf("bang\n");
    printf("%d %d\n", ok, no);
    return 0;
}
