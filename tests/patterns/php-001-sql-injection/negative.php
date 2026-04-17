<?php
// Negative fixture for php-001-sql-injection.
// Prepared statements with placeholders bind values separately
// from the SQL — no interpolation.

function getUser($conn, $username) {
    $stmt = $conn->prepare("SELECT * FROM users WHERE name = ?");
    $stmt->bind_param("s", $username);
    $stmt->execute();
    return $stmt->get_result();
}
