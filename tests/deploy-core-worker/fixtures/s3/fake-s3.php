<?php
// A fake S3 endpoint for emit.php, served by `php -S 127.0.0.1:9765 fake-s3.php`. Each bucket of
// cases.json's `server` answers as listed there — `path` for a path-style request (the bucket is the
// first path segment), `virtual` for a virtual-hosted-style one (the bucket is the first label of the
// host) — and any other bucket with an empty ListObjectsV2 result. Every request is appended to
// requests.jsonl, which emit.php reads and empties.
$cases = json_decode(file_get_contents(__DIR__.'/cases.json'), true);
$headers = function_exists('getallheaders') ? getallheaders() : [];
$host = $_SERVER['HTTP_HOST'] ?? '';
$uri = $_SERVER['REQUEST_URI'];
file_put_contents(__DIR__.'/requests.jsonl', json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'uri' => $uri, 'host' => $host, 'headers' => $headers])."\n", FILE_APPEND);

$label = explode('.', explode(':', $host)[0])[0];
$segments = array_values(array_filter(explode('/', parse_url($uri, PHP_URL_PATH) ?? ''), fn ($s) => $s !== ''));
$answer = null;
foreach ($cases['server'] as $bucket => $styles) {
    if ($label === $bucket && isset($styles['virtual'])) {
        $answer = $styles['virtual'];
    } elseif (in_array($bucket, $segments, true) && isset($styles['path'])) {
        $answer = $styles['path'];
    }
}
$answer ??= ['status' => 200, 'contentType' => 'application/xml', 'body' => '<?xml version="1.0" encoding="UTF-8"?>'."\n".'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated></ListBucketResult>'];
http_response_code($answer['status']);
header('Content-Type: '.$answer['contentType']);
echo $answer['body'];
