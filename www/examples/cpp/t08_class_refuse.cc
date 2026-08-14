#include <cstdio>
class Counter {
public:
    int count;
    int get() { return count; }
};
int main() {
    Counter c;
    c.count = 5;
    printf("%d\n", c.get());
    return 0;
}
