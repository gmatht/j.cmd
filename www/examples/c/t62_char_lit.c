// t62_char_lit: char literals 'x' and char-variable comparisons (v2 —
// chars are 1-char STRINGS in the store, so ==/!= compare with the
// string test operators, not the numeric -eq/-ne)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    char c = 'x';
    if (c == 'x') { printf("is-x\n"); }
    if (c != 'y') { printf("not-y\n"); }
    printf("%c\n", c);
    char d = 'a';
    if (d == 'a') { printf("is-a\n"); }
    return 0;
}
