/* Positive fixture for cpp-014-fread-return-ignored.
 * fread result discarded; the struct is parsed as if a full read
 * happened. A short read leaves uninitialized bytes in `out`.
 */
#include <stdio.h>
#include <stdint.h>

struct header { uint32_t magic; uint32_t length; };

int parse(FILE *f, struct header *out) {
    fread(out, sizeof *out, 1, f);
    return (int)out->length;
}
