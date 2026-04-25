// Positive fixture for fsw-016-frame-length-as-offset.
// header.get_lengthField() goes straight into moveDeserToOffset
// without an upper-bound check — a malformed frame with a giant
// length walks the deserializer past valid memory.
#include <Fw/Buffer/Buffer.hpp>

void parse_frame(Fw::Buffer data, Fw::Deserializer &deserializer, FrameHeader &header) {
    header.deserializeFrom(deserializer);
    deserializer.moveDeserToOffset(FrameHeader::SERIALIZED_SIZE + header.get_lengthField());
}
