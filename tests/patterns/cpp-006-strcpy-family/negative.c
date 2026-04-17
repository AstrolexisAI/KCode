// Negative fixture for cpp-006-strcpy-family.
// Bounded variants (strncpy, snprintf) are not tracked by this
// pattern — they require length to be passed explicitly.
#include <string.h>
#include <stdio.h>

void greet(const char *name, size_t name_len) {
    char buf[16];
    strncpy(buf, name, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';
}

void format_msg(char *out, size_t n, const char *src) {
    snprintf(out, n, "Message: %s", src);
}
