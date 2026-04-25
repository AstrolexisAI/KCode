// Positive fixture for fsw-020-fwtime-getseconds-no-tb-check.
// Two Fw::Time values from different sources subtracted directly —
// no TimeBase compatibility check. If one is TB_PROC_TIME and the
// other is TB_WORKSTATION_TIME the delta is meaningless.
#include <Fw/Time/Time.hpp>

U32 elapsed(const Fw::Time &start, const Fw::Time &now) {
    return now.getSeconds() - start.getSeconds();
}
