<?php
// The Resend API for emit.php: `php -S 127.0.0.1:<port> resend-capture.php`. It appends every request it
// gets (method, path, headers, body) as one JSON line to the file in RESEND_CAPTURE_FILE and answers as
// Resend does when it accepts an email.
$headers = [];
foreach (getallheaders() as $name => $value) {
    $headers[$name] = $value;
}
file_put_contents(getenv('RESEND_CAPTURE_FILE'), json_encode([
    'method' => $_SERVER['REQUEST_METHOD'],
    'path' => $_SERVER['REQUEST_URI'],
    'headers' => $headers,
    'body' => file_get_contents('php://input'),
])."\n", FILE_APPEND);
header('Content-Type: application/json');
echo '{"id":"49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}';
