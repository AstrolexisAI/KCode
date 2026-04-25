// Positive fixture for java-021-spring-restbody-map.
// @RequestBody Map<String,Object> defeats schema validation — any
// field the attacker sends ends up in the map.
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

class UserController {
    @PostMapping("/users")
    public void create(@RequestBody Map<String, Object> body) {
        repo.save(body);
    }

    private final UserRepo repo = new UserRepo();
}
class UserRepo { public void save(Map<String, Object> body) {} }
