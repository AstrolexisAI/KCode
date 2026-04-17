// Positive fixture for java-010-hardcoded-creds.
// Long-lived secrets as source-code string literals always leak
// eventually (git history, docker layers, pastebins).
public class DbConfig {
    // CONFIRMED: 32-char literal pulled out of AWS panel, baked in source.
    public static final String password = "p@ssw0rd_prod_admin_2026_01_01";
    public static final String apiKey = "sk-live-abcdef0123456789abcdef0123";
}
