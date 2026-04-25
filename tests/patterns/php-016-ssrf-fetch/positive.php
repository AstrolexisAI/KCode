<?php
// Positive fixture for php-016-ssrf-fetch.
// file_get_contents on $_GET['url'] lets the attacker fetch any
// URL the server can reach — internal services, AWS metadata,
// even file:// URLs in older PHP.
function proxy() {
    $body = file_get_contents($_GET['url']);
    echo $body;
}
