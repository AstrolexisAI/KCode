// Negative fixture for java-010-hardcoded-creds.
// Credentials read from environment or vault at runtime don't
// match the literal-assignment pattern.
public class DbConfig {
    public static String password() {
        return System.getenv("DB_PASSWORD");
    }
    public static String apiKey() {
        return VaultClient.fetch("api-key");
    }
}
class VaultClient {
    static String fetch(String key) { return ""; }
}
