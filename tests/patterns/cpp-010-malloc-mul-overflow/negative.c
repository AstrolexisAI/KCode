// Negative fixture for cpp-010-malloc-mul-overflow.
// calloc with a single-factor size or malloc with sizeof alone
// doesn't trip the n * sizeof pattern.
#include <stdlib.h>

void *alloc_single(void) {
    return malloc(64);
}

void *alloc_struct(void) {
    return malloc(sizeof(struct timespec));
}
