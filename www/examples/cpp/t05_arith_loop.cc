#include <cstdio>
int main() {
    int sum = 0;
    for (int i = 1; i <= 4; i++) {
        sum += i;
    }
    printf("sum=%d\n", sum);
    int n = 0;
    while (n < 3) {
        n++;
    }
    printf("n=%d\n", n);
    return 0;
}
