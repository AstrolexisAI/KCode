// Negative fixture for java-002-deserialization.
// JSON deserializers like Jackson or Gson with explicit types are
// not Java-native deserialization — the pattern targets
// ObjectInputStream constructor specifically.
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;

public class SessionLoader {
    private final ObjectMapper mapper = new ObjectMapper();
    public Session load(InputStream untrusted) throws Exception {
        return mapper.readValue(untrusted, Session.class);
    }
}
class Session {}
