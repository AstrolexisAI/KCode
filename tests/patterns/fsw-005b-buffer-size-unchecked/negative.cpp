// Negative fixture for fsw-005b-buffer-size-unchecked.
// FW_ASSERT(buffer.getSize() >= ...) is present BEFORE any pointer
// arithmetic on getData(). The regex's negative lookahead matches
// the upstream check and skips this site.
#include <Fw/Buffer/Buffer.hpp>
#include <Fw/Types/Assert.hpp>

void deframe_safe(Fw::Buffer data, U32 lengthField) {
  FW_ASSERT(data.getSize() >= lengthField + 8);
  for (U32 i = 0; i < lengthField + 8; i++) {
    U8 byte = *(data.getData() + i);
    (void)byte;
  }
}
