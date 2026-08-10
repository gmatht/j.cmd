// my_qsort.c — a C sort whose comparator is a BASH function.
//
// The signature mirrors libc qsort:
//     void qsort(void *base, size_t nitems, size_t size,
//                int (*compar)(const void *, const void *))
// mapped onto the c-sh-go transpiler's world, where the runtime store is
// UNTYPED (every value is a string) and a POINTER is a NAME:
//   * void *base     — the array's variable name (arrays decay to their
//                      name at the call site: `my_qsort(a, 4, cmp)`).
//                      `void` is the ANY verdict — base[j] just reads
//                      the word at index j and hands it to the
//                      comparator, no cast, no deref (the "cast" is
//                      implicit: there are no types at runtime).
//   * size_t nitems  — `int nitems` here (size_t needs typedefs).
//   * size_t size    — dropped: store elements are single untyped words.
//   * compar         — a real C function-pointer parameter; the call
//                      `(*cmp)(a, b)` is the comparator bridge — it
//                      dispatches to whatever bash function the caller
//                      passed (the pointer VALUE is the function's NAME,
//                      a string) and captures its echoed -1/0/1 verdict,
//                      the C qsort comparator protocol.
//
// HOW TO RUN (in j.cmd — the transpiled path, NOT `cc`):
//   source /examples/sh-posix/alphanumeric_compare.sh   # the comparator
//   source /examples/c/my_qsort.c                       # defines + runs
//   → apple banana fig pear
//
//   # swap any protocol-compatible bash comparator — descending:
//   reverse_compare() { if [[ "$1" > "$2" ]]; then echo -1;
//                       elif [[ "$1" < "$2" ]]; then echo 1;
//                       else echo 0; fi }
//   a=(pear apple fig banana); my_qsort a 4 reverse_compare; echo "${a[@]}"
//
// NOTE: the function-pointer call is a TRANSPILER bridge — this file does not compile
// with `cc` (cproc); it runs through `source`, which parses C with the
// c-sh-go frontend and executes the generated JS in the shell runtime.
#include <stdio.h>

int my_qsort(void *base, int nitems, int (*cmp)(const void *, const void *)) {
  int i;
  int j;
  i = 0;
  while (i < nitems - 1) {
    j = 0;
    while (j < nitems - 1 - i) {
      if ((*cmp)(base[j], base[j + 1]) > 0) {
        char *t = base[j];
        base[j] = base[j + 1];
        base[j + 1] = t;
      }
      j = j + 1;
    }
    i = i + 1;
  }
  return 0;
}

int main() {
  printf("my_qsort.c — a C sort whose comparator is a BASH function (sourced into this shell)\n");
  printf("\n");
  printf("  first source a comparator — a bash function echoing the C -1/0/1 protocol:\n");
  printf("    source /examples/sh-posix/alphanumeric_compare.sh\n");
  printf("\n");
  printf("  then sort any array IN PLACE — the comparator's NAME is the function-pointer value:\n");
  printf("    a=(pear apple fig banana); my_qsort a 4 alphanumeric_compare; echo \"${a[@]}\"\n");
  printf("    -> apple banana fig pear\n");
  printf("  (swap in any protocol-compatible bash function, e.g. reverse_compare)\n");
  printf("\n");
  printf("  demo (this run):\n");
  char *a[4] = {"pear", "apple", "fig", "banana"};
  my_qsort(a, 4, "alphanumeric_compare");
  int k;
  for (k = 0; k < 4; k++) {
    printf("%s ", a[k]);
  }
  printf("\n");
  return 0;
}
