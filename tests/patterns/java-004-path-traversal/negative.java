// Negative fixture for java-004-path-traversal.
// new File with a hardcoded resource path is safe.
import java.io.File;

public class ConfigLoader {
    private static final File CONFIG = new File("/etc/myapp/config.yaml");

    public File get() {
        return CONFIG;
    }
}
