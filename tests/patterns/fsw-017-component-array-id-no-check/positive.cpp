// Positive fixture for fsw-017-component-array-id-no-check.
// Telemetry packetizer indexes m_channels with the chanId from a
// deserialized command — no upper-bound check.
#include <Fw/FPrimeBasicTypes.hpp>

class TlmPacketizer {
public:
    void writeTlm_handler(const TlmCommand &cmd) {
        this->m_channels[cmd.chanId] = cmd.value;
    }
private:
    U32 m_channels[64];
};
