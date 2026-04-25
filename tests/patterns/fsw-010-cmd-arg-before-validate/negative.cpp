// Negative fixture for fsw-010-cmd-arg-before-validate.
// Length check + cmdResponse VALIDATION_ERROR before any side effect.
#include <Fw/Cmd/CmdString.hpp>
#include <Os/FileSystem.hpp>

class FileManager {
public:
    void RemoveFile_cmdHandler(const FwOpcodeType opCode,
                               const U32 cmdSeq,
                               const Fw::CmdStringArg& fileName) {
        // audit-fix:fsw-010 — reject malformed ground-command argument before any side effect.
        if (fileName.length() == 0 || fileName.length() >= Fw::CmdStringArg::SERIALIZED_SIZE) {
            this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::VALIDATION_ERROR);
            return;
        }
        Os::FileSystem::removeFile(fileName.toChar());
        this->cmdResponse_out(opCode, cmdSeq, Fw::CmdResponse::OK);
    }
private:
    void cmdResponse_out(FwOpcodeType, U32, int = 0) {}
};
