// Derived from coollabsio/coolify@91b7e3e:app/Helpers/SshMultiplexingHelper.php and
// bootstrap/helpers/remoteProcess.php (Apache-2.0), modified: the SSH execution
// Coolify does with the `ssh` binary, as a small Go service for a Cloudflare
// Container. It is reachable only from the SshSession Durable Object in
// deploy-core-worker; it holds no state and never logs a key or a command.
//
//	GET  /health
//	POST /exec    { conn, commands[], timeout }        NDJSON: hostkey, out, err, exit | error
//	POST /upload  { conn, path, contentBase64, mode }  JSON:   { exit } | { error }
//
// Semantics kept from Coolify:
//   - the remote command is Coolify's remoteShellCommand(): `sh -c "if command -v bash
//     >/dev/null 2>&1; then exec bash -se; else exec sh -se; fi"`, with the commands
//     joined by "\n" plus a final newline on stdin (instant_remote_process,
//     sshBatchInput), so nothing is on a command line;
//   - no agent, no forwarding, no TTY, key authentication only;
//   - ConnectTimeout 10 s and ServerAliveInterval 20 s by default (config/constants.php),
//     the command timeout 3600 s by default (`timeout {n} ssh`);
//   - host keys are trusted on first use and then pinned: a different key is refused
//     with Coolify's HOST_KEY_CHANGED_MESSAGE.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// HostKeyChangedMessage is Coolify's SshMultiplexingHelper::HOST_KEY_CHANGED_MESSAGE, brand swapped.
const HostKeyChangedMessage = "The SSH host key of this server changed, so Freeploy did not connect. An admin must check the new key on the Security page of the server."

// RemoteShellCommand is Coolify's remoteShellCommand().
const RemoteShellCommand = `sh -c "if command -v bash >/dev/null 2>&1; then exec bash -se; else exec sh -se; fi"`

const (
	defaultConnectTimeout = 10
	defaultServerInterval = 20
	defaultCommandTimeout = 3600
)

// Conn is one server: where, as whom, with which key, and the pinned host key if known.
type Conn struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	PrivateKey     string `json:"privateKey"`
	HostKey        string `json:"hostKey"` // authorized_keys format; empty = trust on first use
	ConnectTimeout int    `json:"connectTimeout"`
	ServerInterval int    `json:"serverInterval"`
}

type execRequest struct {
	Conn     Conn     `json:"conn"`
	Commands []string `json:"commands"`
	Timeout  int      `json:"timeout"`
}

type uploadRequest struct {
	Conn          Conn   `json:"conn"`
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Mode          string `json:"mode"`
}

// Event is one NDJSON line of an /exec response.
type Event struct {
	T       string `json:"t"`
	Line    string `json:"line,omitempty"`
	Key     string `json:"key,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

var errHostKeyChanged = errors.New(HostKeyChangedMessage)

// dial connects with Coolify's options and reports the host key it saw.
func dial(ctx context.Context, c Conn) (*ssh.Client, string, error) {
	signer, err := ssh.ParsePrivateKey([]byte(c.PrivateKey))
	if err != nil {
		return nil, "", fmt.Errorf("the private key could not be read: %w", err)
	}
	var pinned ssh.PublicKey
	if strings.TrimSpace(c.HostKey) != "" {
		pinned, _, _, _, err = ssh.ParseAuthorizedKey([]byte(c.HostKey))
		if err != nil {
			return nil, "", fmt.Errorf("the pinned host key could not be read: %w", err)
		}
	}
	seen := ""
	timeout := c.ConnectTimeout
	if timeout <= 0 {
		timeout = defaultConnectTimeout
	}
	cfg := &ssh.ClientConfig{
		User: c.User,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			seen = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
			if pinned != nil && !bytes.Equal(pinned.Marshal(), key.Marshal()) {
				return errHostKeyChanged
			}
			return nil
		},
		Timeout: time.Duration(timeout) * time.Second,
	}
	port := c.Port
	if port == 0 {
		port = 22
	}
	addr := net.JoinHostPort(c.Host, strconv.Itoa(port))
	d := net.Dialer{Timeout: cfg.Timeout}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, seen, err
	}
	conn, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
	if err != nil {
		raw.Close()
		if errors.Is(err, errHostKeyChanged) || strings.Contains(err.Error(), HostKeyChangedMessage) {
			return nil, seen, errHostKeyChanged
		}
		return nil, seen, err
	}
	client := ssh.NewClient(conn, chans, reqs)
	interval := c.ServerInterval
	if interval <= 0 {
		interval = defaultServerInterval
	}
	go keepAlive(ctx, client, time.Duration(interval)*time.Second)
	return client, seen, nil
}

// keepAlive is ServerAliveInterval: a request every interval until the context ends.
func keepAlive(ctx context.Context, c *ssh.Client, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				return
			}
		}
	}
}

// BatchInput is sshBatchInput(implode("\n", commands)): the batch plus a final newline.
func BatchInput(commands []string) string {
	return strings.Join(commands, "\n") + "\n"
}

// runExec runs the batch and emits events; it returns once the remote command ends.
func runExec(ctx context.Context, req execRequest, emit func(Event)) {
	timeout := req.Timeout
	if timeout <= 0 {
		timeout = defaultCommandTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	client, seen, err := dial(ctx, req.Conn)
	if seen != "" {
		emit(Event{T: "hostkey", Key: seen})
	}
	if err != nil {
		code := 255
		emit(Event{T: "error", Code: &code, Message: err.Error()})
		return
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		code := 255
		emit(Event{T: "error", Code: &code, Message: err.Error()})
		return
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(BatchInput(req.Commands))
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()

	var mu sync.Mutex
	send := func(e Event) {
		mu.Lock()
		defer mu.Unlock()
		emit(e)
	}
	var wg sync.WaitGroup
	pump := func(r io.Reader, kind string) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for sc.Scan() {
			send(Event{T: kind, Line: sc.Text()})
		}
	}
	if err := sess.Start(RemoteShellCommand); err != nil {
		code := 255
		emit(Event{T: "error", Code: &code, Message: err.Error()})
		return
	}
	wg.Add(2)
	go pump(stdout, "out")
	go pump(stderr, "err")
	done := make(chan error, 1)
	go func() {
		wg.Wait()
		done <- sess.Wait()
	}()
	select {
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGKILL)
		code := 124 // timeout(1)'s exit status, as `timeout {n} ssh` reports it
		send(Event{T: "exit", Code: &code})
	case err := <-done:
		code := 0
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitStatus()
		} else if err != nil {
			code = 255
		}
		send(Event{T: "exit", Code: &code})
	}
}

// UploadCommand writes stdin to path and sets its mode (Coolify's transfer_file, through stdin).
func UploadCommand(path, mode string) string {
	if mode == "" {
		mode = "0644"
	}
	return "sh -c 'cat > \"$1\" && chmod \"$2\" \"$1\"' sh " + shellQuote(path) + " " + shellQuote(mode)
}

// shellQuote is PHP's escapeshellarg on POSIX.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func runUpload(ctx context.Context, req uploadRequest) (int, string, error) {
	content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		return 0, "", fmt.Errorf("contentBase64 is not base64: %w", err)
	}
	client, seen, err := dial(ctx, req.Conn)
	if err != nil {
		return 255, seen, err
	}
	defer client.Close()
	sess, err := client.NewSession()
	if err != nil {
		return 255, seen, err
	}
	defer sess.Close()
	sess.Stdin = bytes.NewReader(content)
	var stderr bytes.Buffer
	sess.Stderr = &stderr
	err = sess.Run(UploadCommand(req.Path, req.Mode))
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitStatus(), seen, errors.New(strings.TrimSpace(stderr.String()))
	}
	if err != nil {
		return 255, seen, err
	}
	return 0, seen, nil
}

func handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("POST /exec", func(w http.ResponseWriter, r *http.Request) {
		var req execRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&req); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		w.Header().Set("content-type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		enc := json.NewEncoder(w)
		runExec(r.Context(), req, func(e Event) {
			_ = enc.Encode(e)
			if flusher != nil {
				flusher.Flush()
			}
		})
	})
	mux.HandleFunc("POST /upload", func(w http.ResponseWriter, r *http.Request) {
		var req uploadRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(&req); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		code, seen, err := runUpload(r.Context(), req)
		w.Header().Set("content-type", "application/json")
		out := map[string]any{"exit": code, "hostkey": seen}
		if err != nil {
			out["error"] = err.Error()
		}
		_ = json.NewEncoder(w).Encode(out)
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	// No request logging: bodies carry private keys and commands.
	log.Printf("ssh-executor listening on :%s", port)
	srv := &http.Server{Addr: ":" + port, Handler: handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(srv.ListenAndServe())
}
