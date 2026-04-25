// Negative fixture for fsw-020-fwtime-getseconds-no-tb-check.
// Use Fw::Time::sub() — the framework helper that takes both Time
// values and encodes the TimeBase-agreement contract internally.
// The pattern's regex looks for explicit `.getSeconds() - .getSeconds()`
// shape, which Fw::Time::sub() doesn't have.
#include <Fw/Time/Time.hpp>

Fw::Time elapsed(const Fw::Time &start, const Fw::Time &now) {
    return Fw::Time::sub(now, start);
}
