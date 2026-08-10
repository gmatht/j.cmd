/* ── examples/source.c — C-flavoured constants (sourced by jtsh) ──
   source examples/source.c
   The variables become $vars in the shell; the three C functions
   become callable shell functions (the c frontend emits the pointer
   walks). Sourcing prints how to use them. This file is also a
   valid little C translation unit — compile it with tcc/cc. */
#include <stdio.h>
int MAX_RETRIES = 5;
int APP_ID = 7;
int width = 80;
int height = 24;
int GRACE = 3;

/* ── more C flavour: arithmetic + char* strings ── */
int FULL_W = 80 * 2;             /* width * 2 */
int CUBE   = 80 * 80 * 80;       /* width * width * width */
char *BANNER = "c-sourced";
char *GREETING = "hello from C";
int RETRIES = 5 + 3;             /* MAX_RETRIES + GRACE */
int AREA   = 80 * 24;            /* width * height */

/* a real C function with pointer arithmetic: sum the first n ints
   of s. Valid C — compile with tcc/cc; when sourced it becomes a
   callable shell function (the c frontend emits the pointer walk).

   Run it from jtsh:
     source examples/source.c
     a=(10 20 30)
     addr a                        -> \u0001mem:a:0   (the array's pointer)
     sum_first "$(addr a)" 3; echo $?    -> 60
   (the function returns its value, so a bare call leaves it in $?.) */
int sum_first(int *s, int n) {
    int total = 0;
    while (n > 0) {
        total += *s;
        s = s + 1;
        n = n - 1;
    }
    return total;
}

/* a pointer WRITE: fill the first n ints through the pointer — the
   writes land in the caller's shell array (C call-by-reference):
     fill "$(addr a)" 3; echo "a=($a)"    -> a=(0 10 20) */
int fill(int *p, int n) {
    int i = 0;
    while (i < n) {
        *p++ = i * 10;
        i = i + 1;
    }
    return 0;
}

/* a READ+WRITE walk: selection-sort the first n ints in place —
   the swaps land in the caller's shell array (call-by-reference):
     a=(10 30 20)
     sort_ints "$(addr a)" 3; echo "a=($a)"    -> a=(10 20 30) */
int sort_ints(int *a, int n) {
    int i, j, t;
    for (i = 0; i < n - 1; i = i + 1) {
        for (j = i + 1; j < n; j = j + 1) {
            if (a[j] < a[i]) {
                t = a[i];
                a[i] = a[j];
                a[j] = t;
            }
        }
    }
    return 0;
}

/* sourcing prints the instructions below — the three functions are
   now callable shell functions (a pointer is a NAME, so the array
   name works directly; addr prints the \u0001mem handle form). */
int main() {
  printf("source.c — C constants + pointer-walk functions (sourced into this shell)\n");
  printf("\n");
  printf("  the constants are now shell variables: $MAX_RETRIES $APP_ID $width $height\n");
  printf("  $GRACE $FULL_W $CUBE $BANNER $GREETING $RETRIES $AREA\n");
  printf("\n");
  printf("  sum_first NAME N  — sum the first N ints of the array NAME; the C\n");
  printf("    return value lands in $?:\n");
  printf("    a=(10 20 30); sum_first \"$(addr a)\" 3; echo $?    -> 60\n");
  printf("    (a pointer is a NAME — sum_first a 3 works too; addr prints the handle)\n");
  printf("\n");
  printf("  fill NAME N       — write 0..N-1 through the pointer (call-by-reference):\n");
  printf("    fill a 3; echo \"a=($a)\"    -> a=(0 10 20)\n");
  printf("\n");
  printf("  sort_ints NAME N  — selection-sort the first N ints in place:\n");
  printf("    b=(10 30 20); sort_ints b 3; echo \"b=($b)\"    -> b=(10 20 30)\n");
  return 0;
}

