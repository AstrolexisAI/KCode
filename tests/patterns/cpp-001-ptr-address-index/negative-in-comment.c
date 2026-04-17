// Negative fixture for cpp-001-ptr-address-index — comment-awareness
// regression. Before Phase 3b, the scanner had no idea what a
// comment was, so example code inside doc comments was flagged as
// if it were real code. Now computeCommentRanges() strips matches
// that fall inside // line comments or block comments.

// Example showing a buggy pattern: (&buffer)[n] was the NASA IDF
// bug — it reads stack memory instead of buffer contents. We
// document it here but NOT in executable code. The scanner must
// NOT treat this as a real finding.

#include <stdint.h>

/* Another comment block, same deal:
 *   bad:  (&ptr)[1]
 *   good: (char*)ptr + 1
 * Neither of these should trip the scanner.
 */
static uint8_t read_byte(const uint8_t *buf, size_t idx) {
    return buf[idx];
}
