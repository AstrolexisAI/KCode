<?php
// Negative fixture for php-016-ssrf-fetch.
// Allowlist + scheme + IP check before file_get_contents.
const ALLOWED = ['api.partner.example', 'hooks.partner.example'];

function proxy() {
    $url = $_GET['url'] ?? '';
    $parts = parse_url($url);
    if (!$parts || ($parts['scheme'] ?? '') !== 'https') {
        http_response_code(400);
        return;
    }
    $host = $parts['host'] ?? '';
    if (!in_array($host, ALLOWED, true)) {
        http_response_code(400);
        return;
    }
    $ip = gethostbyname($host);
    if (str_starts_with($ip, '10.') || str_starts_with($ip, '127.') || $ip === '169.254.169.254') {
        http_response_code(400);
        return;
    }
    echo file_get_contents($url);
}
