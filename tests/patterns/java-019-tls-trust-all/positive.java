// Positive fixture for java-019-tls-trust-all.
// X509TrustManager whose checkServerTrusted is empty accepts every
// certificate including attacker-presented ones — full MITM.
import javax.net.ssl.X509TrustManager;
import java.security.cert.X509Certificate;

class TrustAllAttempt {
    static X509TrustManager trustAll() {
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            @Override
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }
}
