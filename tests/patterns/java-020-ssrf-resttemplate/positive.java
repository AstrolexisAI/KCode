// Positive fixture for java-020-ssrf-resttemplate.
// RestTemplate.getForObject called with @RequestParam value — the
// attacker can point the URL at AWS metadata (169.254.169.254)
// or any internal service.
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.client.RestTemplate;

class WebhookController {
    private final RestTemplate restTemplate = new RestTemplate();

    @GetMapping("/proxy")
    public String proxy(@RequestParam String input) {
        return restTemplate.getForObject(input, String.class);
    }
}
