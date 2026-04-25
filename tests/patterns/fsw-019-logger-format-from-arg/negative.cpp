// Negative fixture for fsw-019-logger-format-from-arg.
// Format string is a literal; the variable is the value.
#include <Fw/Logger/Logger.hpp>

void emit_event(U32 value) {
    Fw::Logger::log("event_value=%u\n", value);
}
