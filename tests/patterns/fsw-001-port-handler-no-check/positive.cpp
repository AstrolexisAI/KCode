// Positive fixture for fsw-001-port-handler-no-check.
// Component port handler dispatches without verifying its index
// argument is in range — out-of-bounds array access on a malformed
// schedule.
#include <Fw/FPrimeBasicTypes.hpp>

class Component {
public:
    void rateGroup_handler(FwIndexType portNum) {
        this->m_callbacks[portNum]();
    }
private:
    void (*m_callbacks[4])();
};
