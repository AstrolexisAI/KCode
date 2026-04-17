// Positive fixture for java-001-sql-injection.
// Concatenating user input into a query string is the textbook
// SQL injection vector. The regex catches "string " + var or
// var + " string" passed to execute*.
import java.sql.*;

public class UserDao {
    public ResultSet findByUsername(Connection conn, String username) throws SQLException {
        Statement stmt = conn.createStatement();
        // CONFIRMED: username is attacker-controlled.
        return stmt.executeQuery("SELECT * FROM users WHERE name = '" + username + "'");
    }
}
