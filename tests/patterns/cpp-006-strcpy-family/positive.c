// Positive fixture for cpp-006-strcpy-family.
// Unbounded string primitives are textbook buffer-overflow vectors.
#include <string.h>
#include <stdio.h>

void greet(const char *name) {
    char buf[16];
    // CONFIRMED: strcpy with no length check.
    strcpy(buf, name);
    printf("Hello, %s\n", buf);
}

void format_msg(char *out, const char *src) {
    // CONFIRMED: sprintf can overrun out.
    sprintf(out, "Message: %s", src);
}
