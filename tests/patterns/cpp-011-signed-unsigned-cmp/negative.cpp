// Negative fixture for cpp-011-signed-unsigned-cmp.
// Using size_t (or the container's size_type) as the loop index
// avoids the signed/unsigned compare.
#include <vector>

int sum_all(const std::vector<int> &data) {
    int total = 0;
    for (std::size_t i = 0; i < data.size(); ++i) {
        total += data[i];
    }
    return total;
}
