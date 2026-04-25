// Negative fixture for fsw-005-buffer-getdata-unchecked.
// Storing getData() in a local variable that is null-checked before
// any indexing — the regex pattern only fires on direct
// `buf.getData() + N` / `buf.getData()[i]` / `buf.getData()->` shapes.
#include <Fw/Buffer/Buffer.hpp>
#include <Fw/Types/Assert.hpp>

void process_frame(Fw::Buffer fwBuffer) {
    U8* p = fwBuffer.getData();
    FW_ASSERT(p != nullptr);
    p[0] = 0;
    p[1] = 1;
}
