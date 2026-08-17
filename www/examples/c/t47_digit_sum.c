// t47_digit_sum: digit extraction via % and / in a loop
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    int n = 9876;
    int sum = 0;
    while (n > 0) {
        sum = sum + n % 10;
        n = n / 10;
    }
    printf("%d\n", sum);
    return 0;
}
