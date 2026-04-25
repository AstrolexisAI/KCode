// Positive fixture for fsw-010-cmd-arg-before-validate.
// Ground command path arrives over the flight-link with an
// attacker-controllable Fw::CmdStringArg. Passing it directly to a
// sink without a containment check is CWE-22 path traversal.
#include <Fw/Cmd/CmdString.hpp>
#include <Os/FileSystem.hpp>

class FileManager {
public:
    void RemoveFile_cmdHandler(const FwOpcodeType opCode,
                               const U32 cmdSeq,
                               const Fw::CmdStringArg& fileName) {
        Os::FileSystem::removeFile(fileName.toChar());
    }
};
