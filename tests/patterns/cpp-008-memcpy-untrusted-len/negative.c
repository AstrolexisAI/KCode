// Negative fixture for cpp-008-memcpy-untrusted-len.
// memcpy with a constant or sizeof-based length is safe.
#include <string.h>
#include <stdint.h>

void copy_header(uint8_t *dst, const uint8_t *src) {
    memcpy(dst, src, 16);
}

void copy_sized(uint8_t *dst, const uint8_t *src) {
    memcpy(dst, src, sizeof(uint32_t));
}
