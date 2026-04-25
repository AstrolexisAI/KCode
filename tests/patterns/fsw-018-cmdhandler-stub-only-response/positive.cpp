// Positive fixture for fsw-018-cmdhandler-stub-only-response.
// Handler whose body is just cmdResponse_out OK — looks like a
// forgotten stub that lies to the ground station.
#include <Fw/Cmd/CmdString.hpp>

class WatchDog {
public:
    void RESET_CYCLE_COUNT_cmdHandler(const FwOpcodeType opCode, const U32 cmdSeq) {
        this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::OK);
    }
private:
    void cmdResponse_out(FwOpcodeType, U32, int) {}
};
