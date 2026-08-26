/* ── factor.c — prime factorization by trial division (the C twin of
   www/examples/factor.sh; the GPU-lift case study). The C baseline for
   the shader-lift benchmark: compile with cc/tcc and run against the
   same numbers as the bash version (__factor-bench.mjs does both).

     cc factor.c -o factor && ./factor 360
     tcc factor.c -o factor && ./factor 2147483647

   The trial-division core is identical to the bash version's — the
   benchmark measures how much faster the same algorithm is in C, and
   where the shader-lift (batch/sieve) would sit relative to both. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdbool.h>

int main(int argc, char *argv[]) {
    // Check if a number was provided
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <number>\n", argv[0]);
        return 1;
    }

    // Check if the string contains only digits
    for (int i = 0; argv[1][i] != '\0'; i++) {
        if (!isdigit(argv[1][i])) {
            fprintf(stderr, "Error: Invalid input. Please provide a positive integer.\n");
            return 1;
        }
    }

    // Convert string to unsigned long long
    unsigned long long n = strtoull(argv[1], NULL, 10);

    // Check if it's greater than 1
    if (n <= 1) {
        fprintf(stderr, "Error: Please provide a composite integer greater than 1.\n");
        return 1;
    }

    unsigned long long original_n = n;
    unsigned long long d = 2;
    bool is_composite = false;

    printf("Prime factors of %llu: ", original_n);

    // Trial division loop
    // We use d * d <= n to stop at the square root, preventing overflow 
    // that could happen if we did d <= sqrt(n)
    while (d * d <= n) {
        // While d divides n evenly
        while (n % d == 0) {
            printf("%llu ", d);
            is_composite = true;
            n /= d;
        }
        d++;
    }

    // If n is still greater than 1, it is a prime factor itself
    if (n > 1) {
        printf("%llu ", n);
        is_composite = true;
    }

    // Output formatting based on whether factors were found
    if (!is_composite) {
        printf("\n%llu is a prime number, not a composite number.\n", original_n);
    } else {
        printf("\n");
    }

    return 0;
}
