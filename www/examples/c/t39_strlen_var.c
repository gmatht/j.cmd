// t39_strlen_var: strlen of a runtime string variable (${#s} lowering)
// diagnostics: program prints its result to stdout
#include <stdio.h>
#include <string.h>

int main(void) {
    char *s = "hello";
    printf("%d\n", (int)strlen(s));
    return 0;
}
