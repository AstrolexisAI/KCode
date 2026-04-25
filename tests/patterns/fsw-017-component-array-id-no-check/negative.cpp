// Negative fixture for fsw-017-component-array-id-no-check.
// FW_ASSERT bounds chanId before indexing.
#include <Fw/FPrimeBasicTypes.hpp>
#include <Fw/Types/Assert.hpp>

class TlmPacketizer {
public:
    static constexpr U32 NUM_CHANNELS = 64;
    void writeTlm_handler(const TlmCommand &cmd) {
        FW_ASSERT(cmd.chanId < NUM_CHANNELS, cmd.chanId);
        U32 idx = cmd.chanId;
        this->m_channels[idx] = cmd.value;
    }
private:
    U32 m_channels[NUM_CHANNELS];
};
