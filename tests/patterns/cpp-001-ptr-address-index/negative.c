// Negative fixture for cpp-001-ptr-address-index.
// Straight indexing into a pointer is routine and should not
// trip the pattern. The regex looks for an explicit
// address-of-then-index form, which is absent here.
#include <stdint.h>

static void read_stream(const uint8_t *buffer, size_t n) {
    uint8_t first = buffer[0];
    uint8_t at_n  = buffer[n];
    (void)first;
    (void)at_n;
}
