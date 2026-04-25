// Negative fixture for java-020-ssrf-resttemplate.
// Allowlist-checked host before fetching; metadata IPs blocked.
import java.net.InetAddress;
import java.net.URI;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.client.RestTemplate;

class SafeWebhookController {
    private static final Set<String> ALLOWED_HOSTS = Set.of("api.partner.example", "hooks.partner.example");
    private final RestTemplate restTemplate = new RestTemplate();

    @GetMapping("/proxy")
    public String proxy(@RequestParam String url) throws Exception {
        URI u = URI.create(url);
        if (!"https".equals(u.getScheme()) || !ALLOWED_HOSTS.contains(u.getHost())) {
            throw new IllegalArgumentException("disallowed host");
        }
        InetAddress ip = InetAddress.getByName(u.getHost());
        if (ip.isAnyLocalAddress() || ip.isLoopbackAddress() || ip.isSiteLocalAddress()) {
            throw new IllegalArgumentException("internal IP");
        }
        return restTemplate.getForObject(u, String.class);
    }
}
