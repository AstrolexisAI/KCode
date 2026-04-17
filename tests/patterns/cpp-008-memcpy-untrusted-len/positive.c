// Positive fixture for cpp-008-memcpy-untrusted-len.
// memcpy where the length comes from a struct field on an
// attacker-controlled packet is the classic network decoder bug.
#include <string.h>
#include <stdint.h>

struct packet { uint8_t *data; size_t len; };

void decode(uint8_t *dst, const struct packet *pkt) {
    // CONFIRMED: pkt->len is attacker-controlled, no bound check.
    memcpy(dst, pkt->data, pkt->len);
}
