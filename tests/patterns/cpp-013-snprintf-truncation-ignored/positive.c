/* Positive fixture for cpp-013-snprintf-truncation-ignored.
 * Long input gets silently truncated; downstream code parses the
 * partial string assuming a complete write happened.
 */
#include <stdio.h>

void log_request(const char *user_agent) {
    char line[64];
    snprintf(line, sizeof line, "UA=%s timestamp=now", user_agent);
    /* line is treated as a complete log record even though
       a long user_agent truncates "timestamp=now" off. */
    write(1, line, sizeof line);
}
