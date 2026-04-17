// Positive fixture for java-003-xxe.
// DocumentBuilderFactory.newInstance() without explicit
// feature-disabling defaults allows external entity expansion —
// classic XXE.
import javax.xml.parsers.DocumentBuilderFactory;

public class XmlLoader {
    public DocumentBuilderFactory load() {
        // CONFIRMED: no setFeature(FEATURE_SECURE_PROCESSING) etc.
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        return factory;
    }
}
