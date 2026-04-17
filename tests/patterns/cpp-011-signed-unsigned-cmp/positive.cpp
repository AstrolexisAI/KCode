// Positive fixture for cpp-011-signed-unsigned-cmp.
// Comparing a signed int loop counter with container.size()
// (which is size_t / unsigned) compiles with a sign-compare
// warning at best and overflows silently at worst.
#include <vector>

int sum_all(const std::vector<int> &data) {
    int total = 0;
    // CONFIRMED: int i vs data.size() (unsigned).
    for (int i = 0; i < data.size(); ++i) {
        total += data[i];
    }
    return total;
}
