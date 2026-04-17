// Negative fixture for cs-001-sql-injection.
// Parameterized query with SqlCommand.Parameters is safe.
using System.Data.SqlClient;

public class UserDao {
    public SqlDataReader FindByUsername(SqlConnection conn, string username) {
        var cmd = new SqlCommand("SELECT * FROM users WHERE name = @name", conn);
        cmd.Parameters.AddWithValue("@name", username);
        return cmd.ExecuteReader();
    }
}
