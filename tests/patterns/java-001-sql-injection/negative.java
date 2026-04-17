// Negative fixture for java-001-sql-injection.
// PreparedStatement with ? placeholders is the safe form — the
// driver binds values separately from the SQL.
import java.sql.*;

public class UserDao {
    public ResultSet findByUsername(Connection conn, String username) throws SQLException {
        PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE name = ?");
        ps.setString(1, username);
        return ps.executeQuery();
    }
}
