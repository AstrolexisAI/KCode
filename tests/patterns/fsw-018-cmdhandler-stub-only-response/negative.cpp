// Negative fixture for fsw-018-cmdhandler-stub-only-response.
// Handler does the actual work before responding.
#include <Fw/Cmd/CmdString.hpp>

class WatchDog {
public:
    void RESET_CYCLE_COUNT_cmdHandler(const FwOpcodeType opCode, const U32 cmdSeq) {
        this->m_cycle_count = 0;
        this->log_ACTIVITY_HI_CycleCountReset();
        this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::OK);
    }
private:
    U32 m_cycle_count = 0;
    void log_ACTIVITY_HI_CycleCountReset() {}
    void cmdResponse_out(FwOpcodeType, U32, int) {}
};
