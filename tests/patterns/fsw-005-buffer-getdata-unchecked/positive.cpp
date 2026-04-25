// Positive fixture for fsw-005-buffer-getdata-unchecked.
// Fw::Buffer.getData() can return nullptr when the BufferManager is
// exhausted; pointer arithmetic on the result without a guard is a
// reliable null-deref under load.
#include <Fw/Buffer/Buffer.hpp>

void process_frame(Fw::Buffer fwBuffer) {
    U8* rawData = fwBuffer.getData() + 12;
    rawData[0] = 0;
}
