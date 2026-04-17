<?php
// Positive fixture for php-001-sql-injection.
// mysql_query() takes the SQL string as its first argument — any
// variable interpolation inside that string is injection. The
// regex specifically catches "mysql_query(" / "mysqli_query(" /
// "->query(" followed by a quoted string containing "$".

function getUserLegacy($username) {
    // CONFIRMED: $username interpolated into SQL via mysql_query.
    return mysql_query("SELECT * FROM users WHERE name = '$username'");
}

function getUserOO($conn, $username) {
    // CONFIRMED: ->query with interpolated $username.
    return $conn->query("SELECT * FROM users WHERE name = '$username'");
}
