#include <stdio.h>
int main(void) {
    char *s = "hello";
    printf("%s\n", s);
    printf("%c\n", s[0]);
    char *t = s + 1;
    printf("%s\n", t);
    printf("%c\n", t[3]);
    return 0;
}
