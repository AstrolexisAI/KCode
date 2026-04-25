/* Negative fixture for cpp-014-fread-return-ignored.
 * Return value captured + checked. Short reads are detected and the
 * partial-record path returns an error instead of parsing garbage.
 */
#include <stdio.h>
#include <stdint.h>

struct header { uint32_t magic; uint32_t length; };

int parse(FILE *f) {
    struct header h;
    size_t got = fread(&h, sizeof h, 1, f);
    if (got != 1) return -1;
    if (h.magic != 0xCAFEBABE) return -1;
    return (int)h.length;
}
