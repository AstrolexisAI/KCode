// Positive fixture for cpp-001-ptr-address-index.
// (&buffer)[1] on a pointer variable is the NASA IDF bug: reads
// whatever lives on the stack AFTER the pointer variable, not
// "byte 1 of the buffer".
#include <stdint.h>

static void ethernet_decode(const void *buffer, size_t n) {
    // WRONG: intent was probably (char*)buffer + n, but (&buffer)[n]
    // reads n pointer-slots past the address of `buffer` on the stack.
    uint8_t byte = ((const uint8_t *)(&buffer)[1]);
    (void)byte;
}
