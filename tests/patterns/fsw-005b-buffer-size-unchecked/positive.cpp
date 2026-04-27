// Positive fixture for fsw-005b-buffer-size-unchecked.
// Pointer arithmetic off the buffer payload pointer driven by an
// external length field (deserialized from radio frame), with no
// upstream size check. If a malicious frame arrives with the
// length field exceeding the actual allocated buffer, the loop
// reads heap memory past the allocated region —
// Heartbleed-shape vulnerability.
//
// This is the exact pattern observed in fprime
// Svc/FprimeDeframer/FprimeDeframer.cpp:92 (NASA flight code).
#include <Fw/Buffer/Buffer.hpp>

struct Header {
  U32 get_lengthField() const { return m_len; }
  U32 m_len;
};

void deframe(Fw::Buffer data, const Header& header) {
  U32 fieldToHashSize = header.get_lengthField() + 8;
  for (U32 i = 0; i < fieldToHashSize; i++) {
    U8 byte = *(data.getData() + i);
    (void)byte;
  }
}
