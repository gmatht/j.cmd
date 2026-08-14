#include <cstdio>
int main() {
    try {
        throw 5;
    } catch (int e) {
        printf("%d\n", e);
    }
    return 0;
}
