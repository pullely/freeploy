# SSH key fixtures (fake)

Throwaway keys made for `src/ssh-keys.test.ts` with the local `ssh-keygen` and `openssl`.
They protect nothing and are used nowhere else. Do not reuse them.

- `*.openssh`: `ssh-keygen -t <type> -N ""` (OpenSSH format); `encrypted.openssh` has passphrase `pass`.
- `*.pkcs1.pem`, `*.sec1.pem` (`ec256-nopub.sec1.pem` is ec256 via `openssl ec -no_public`), `*.pkcs8.pem`, `dsa.*.pem`, `ed448.pkcs8.pem`, `encrypted.pkcs8.pem`,
  `certificate.pem`: `openssl genrsa` / `ecparam` / `genpkey` / `pkey` / `req -x509`.
- `ed25519.pub`: `ssh-keygen -y -f ed25519.openssh`.
- `ed25519.ppk`: a hand-built PuTTY v3 file carrying `ed25519.pub`'s key (its private part and MAC are dummies).
- `expected.json`: per key, the public key line (no comment) and the SHA-256 / MD5 fingerprints
  as `ssh-keygen -y` and `ssh-keygen -lf -E sha256|md5` print them, minus the `SHA256:` / `MD5:`
  prefix. ed25519.pkcs8.pem and the DSA keys, which this machine's ssh-keygen cannot read,
  were computed from `openssl` output instead.
