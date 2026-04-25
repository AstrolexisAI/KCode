// Negative fixture for java-019-tls-trust-all.
// JDK default TrustManager + a custom CA bundle — no trust-all
// override.
import java.security.KeyStore;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

class DefaultTrust {
    static SSLContext build(KeyStore caStore) throws Exception {
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(
            TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(caStore);
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, tmf.getTrustManagers(), null);
        return ctx;
    }
}
