// Positive fixture for java-004-path-traversal.
// new File(request.getParameter(...)) lets an attacker send
// "../../etc/passwd" and read arbitrary files.
import java.io.File;
import javax.servlet.http.HttpServletRequest;

public class FileServer {
    public File fileFor(HttpServletRequest request) {
        // CONFIRMED: request param controls path.
        return new File(request.getParameter("path"));
    }
}
