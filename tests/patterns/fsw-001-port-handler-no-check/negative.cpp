// Negative fixture for fsw-001-port-handler-no-check.
// FW_ASSERT at the start of the handler bounds portNum, so the
// pattern's mitigation checklist passes.
#include <Fw/FPrimeBasicTypes.hpp>

class Component {
public:
    void rateGroup_handler(FwIndexType portNum) {
        FW_ASSERT(portNum < this->getNum_rateGroup_InputPorts(), portNum);
        this->m_callbacks[portNum]();
    }
private:
    void (*m_callbacks[4])();
    FwIndexType getNum_rateGroup_InputPorts() const { return 4; }
};
