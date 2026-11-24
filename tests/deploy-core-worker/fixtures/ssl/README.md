# SSL fixtures (DP-48)

Throwaway certificates and keys for `src/ssl.test.ts` and `src/ca-certificate.test.ts`.
Nothing here protects anything.

- `php-ca.crt`, `php-ca.key.txt` — a CA made by Coolify's own code path
  (`SslHelper::generateSslCertificate('Coolify CA Certificate', isCaCertificate: true, validityDays: 3650)`
  at coollabsio/coolify@91b7e3e), run with PHP 8.3.6 and OpenSSL 3.0.13.
- `php-leaf.crt` — a leaf from the same function, signed with that CA:
  common name `postgres-abc`, alternative names `DNS:localhost`, `IP:10.0.0.5`,
  `IP:2001:db8::1`, `DNS:postgres-abc`.
- `custom-ca.crt` — a certificate for the same CA key, made with
  `openssl req -x509 -new -key php-ca.key.txt -sha256 -days 3650 -subj "/CN=My Own CA/O=Example"`:
  what a user pastes as a custom CA certificate.

The key file ends in `.txt` because `.gitignore` excludes `*.key` and `*.pem`.
