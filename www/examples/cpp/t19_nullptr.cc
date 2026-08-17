#include <cstdio>
int main() {
    printf("%d %d\n", nullptr == nullptr, nullptr != nullptr);
    if (nullptr == nullptr) printf("is null\n");
    if (nullptr != nullptr) printf("no\n");
    else printf("not null\n");
    return 0;
}
