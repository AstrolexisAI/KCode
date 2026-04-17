// Positive fixture for java-002-deserialization.
// ObjectInputStream on untrusted data is arbitrary code execution
// via readObject gadget chains (log4shell-class bugs).
import java.io.*;

public class SessionLoader {
    public Object load(InputStream untrusted) throws Exception {
        // CONFIRMED: untrusted stream reaches readObject.
        ObjectInputStream ois = new ObjectInputStream(untrusted);
        return ois.readObject();
    }
}
