// Positive fixture for cs-001-sql-injection.
// SqlCommand / ExecuteReader with $"..." interpolation or + concat
// inside the SQL string is injection.
using System.Data.SqlClient;

public class UserDao {
    public SqlDataReader FindByUsername(SqlConnection conn, string username) {
        // CONFIRMED: username interpolated into SQL via $"" string.
        var cmd = new SqlCommand($"SELECT * FROM users WHERE name = '{username}'", conn);
        return cmd.ExecuteReader();
    }
}
