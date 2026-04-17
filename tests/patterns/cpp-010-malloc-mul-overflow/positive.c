// Positive fixture for cpp-010-malloc-mul-overflow.
// Integer overflow in the multiplication `n * sizeof(T)` silently
// allocates a too-small buffer.
#include <stdlib.h>
#include <stdint.h>

void *alloc_array(uint32_t n) {
    // CONFIRMED: n * sizeof(int) can overflow to 0 or a small value.
    return malloc(n * sizeof(int));
}
