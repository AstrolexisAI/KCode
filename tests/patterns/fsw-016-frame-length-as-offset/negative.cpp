// Negative fixture for fsw-016-frame-length-as-offset.
// Length checked against MAX_PAYLOAD_SIZE before any offset move.
#include <Fw/Buffer/Buffer.hpp>

constexpr U32 MAX_PAYLOAD_SIZE = 4096;

void parse_frame(Fw::Buffer data, Fw::Deserializer &deserializer, FrameHeader &header) {
    header.deserializeFrom(deserializer);
    if (header.get_lengthField() > MAX_PAYLOAD_SIZE) {
        return;
    }
    U32 capped = header.get_lengthField();
    deserializer.moveDeserToOffset(FrameHeader::SERIALIZED_SIZE + capped);
}
