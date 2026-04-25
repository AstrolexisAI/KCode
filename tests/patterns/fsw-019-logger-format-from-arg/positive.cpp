// Positive fixture for fsw-019-logger-format-from-arg.
// fmt is a function parameter — caller can pass "%n%n%n" and
// trigger format-string injection.
#include <Fw/Logger/Logger.hpp>

void emit_event(const char *fmt, U32 value) {
    Fw::Logger::log(fmt, value);
}
