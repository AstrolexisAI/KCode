// Negative fixture for java-003-xxe.
// The pattern regex matches the newInstance call itself. This
// file has no DocumentBuilderFactory/SAXParserFactory call, so
// the regex stays cold. A hardened configuration (with feature
// flags) would still match the regex and rely on the verifier
// to mark it FALSE_POSITIVE — out of scope for this harness.
import org.w3c.dom.Document;

public class XmlHelper {
    public Document reuse(Document existing) {
        return existing;
    }
}
