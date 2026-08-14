#include <cstdio>
int main() {
    int n = 3;
    int* a = new int[n];   // variable bound — the shared heap lowering
                           // requires a compile-time size (REFUSE > GUESS)
    printf("%d\n", a[0]);
    delete[] a;
    return 0;
}
