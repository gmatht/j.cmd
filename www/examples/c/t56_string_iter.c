// t56_string_iter: iterate a char* with a DYNAMIC index (s[i] in a loop)
// diagnostics: program prints its result to stdout
#include <stdio.h>

int main(void) {
    char *s = "abc";
    int i;
    for (i = 0; i < 3; i++) {
        printf("%c\n", s[i]);
    }
    return 0;
}
