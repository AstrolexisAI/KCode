// Negative fixture for java-021-spring-restbody-map.
// Typed DTO + Bean Validation — only declared fields are bound.
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

class CreateUserDto {
    @NotBlank @Size(max = 64)
    public String name;
    @NotBlank @Size(max = 320)
    public String email;
}

class UserController {
    @PostMapping("/users")
    public void create(@Valid @RequestBody CreateUserDto body) {
        repo.save(body.name, body.email);
    }

    private final UserRepo repo = new UserRepo();
}
class UserRepo { public void save(String n, String e) {} }
