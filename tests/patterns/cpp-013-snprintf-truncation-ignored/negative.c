/* Negative fixture for cpp-013-snprintf-truncation-ignored.
 * Return value captured + checked against the buffer size; truncation
 * is detected and handled.
 */
#include <stdio.h>

int log_request(const char *user_agent) {
    char line[64];
    int n = snprintf(line, sizeof line, "UA=%s timestamp=now", user_agent);
    if (n < 0 || (size_t)n >= sizeof line) {
        return -1;
    }
    return write(1, line, (size_t)n);
}
