// t15_switch: A1 Case node — switch/case dispatch over an int
// diagnostics: prints the arm taken for each value, incl. default
#include <cstdio>
int main() {
    int x = 2;
    switch (x) {
        case 1: printf("one\n"); break;
        case 2: printf("two\n"); break;
        default: printf("other\n"); break;
    }
    x = 7;
    switch (x) {
        case 1: printf("one\n"); break;
        case 2: printf("two\n"); break;
        default: printf("other\n"); break;
    }
    return 0;
}
