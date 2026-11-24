package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// testServer is a minimal sshd: key auth for one client key, `exec` runs the
// command with the local /bin/sh, piping stdin/stdout/stderr and the exit status.
type testServer struct {
	addr    string
	hostKey ssh.PublicKey
}

func newKey(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signer, string(pem.EncodeToMemory(block))
}

func startServer(t *testing.T, clientKey ssh.PublicKey) *testServer {
	t.Helper()
	hostSigner, _ := newKey(t)
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			if string(k.Marshal()) == string(clientKey.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, io.EOF
		},
	}
	cfg.AddHostKey(hostSigner)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go serve(nc, cfg)
		}
	}()
	return &testServer{addr: ln.Addr().String(), hostKey: hostSigner.PublicKey()}
}

func serve(nc net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		ch, requests, err := nch.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range requests {
				if req.Type != "exec" {
					_ = req.Reply(false, nil)
					continue
				}
				n := binary.BigEndian.Uint32(req.Payload[:4])
				command := string(req.Payload[4 : 4+n])
				_ = req.Reply(true, nil)
				cmd := exec.Command("/bin/sh", "-c", command)
				cmd.Stdin, cmd.Stdout, cmd.Stderr = ch, ch, ch.Stderr()
				status := 0
				if err := cmd.Run(); err != nil {
					if ee, ok := err.(*exec.ExitError); ok {
						status = ee.ExitCode()
					} else {
						status = 255
					}
				}
				b := make([]byte, 4)
				binary.BigEndian.PutUint32(b, uint32(status))
				_, _ = ch.SendRequest("exit-status", false, b)
				ch.Close()
				return
			}
		}()
	}
}

func conn(t *testing.T, s *testServer, key string, pinned string) Conn {
	host, port, _ := net.SplitHostPort(s.addr)
	p, _ := strconv.Atoi(port)
	return Conn{Host: host, Port: p, User: "root", PrivateKey: key, HostKey: pinned, ConnectTimeout: 5}
}

func collect(t *testing.T, req execRequest) []Event {
	t.Helper()
	var out []Event
	runExec(context.Background(), req, func(e Event) { out = append(out, e) })
	return out
}

func lines(evts []Event, kind string) []string {
	var out []string
	for _, e := range evts {
		if e.T == kind {
			out = append(out, e.Line)
		}
	}
	return out
}

func exitCode(evts []Event) int {
	for _, e := range evts {
		if (e.T == "exit" || e.T == "error") && e.Code != nil {
			return *e.Code
		}
	}
	return -1
}

func TestExecRunsTheBatchWithSetE(t *testing.T) {
	signer, key := newKey(t)
	s := startServer(t, signer.PublicKey())
	evts := collect(t, execRequest{Conn: conn(t, s, key, ""), Commands: []string{"echo one", "echo two >&2", "false", "echo never"}})
	if got := lines(evts, "out"); strings.Join(got, ",") != "one" {
		t.Fatalf("stdout = %v", got)
	}
	if got := lines(evts, "err"); strings.Join(got, ",") != "two" {
		t.Fatalf("stderr = %v", got)
	}
	// bash -se / sh -se: the batch stops at the first failing command.
	if c := exitCode(evts); c != 1 {
		t.Fatalf("exit = %d", c)
	}
	if evts[0].T != "hostkey" || !strings.HasPrefix(evts[0].Key, "ssh-ed25519 ") {
		t.Fatalf("first event should report the host key, got %+v", evts[0])
	}
}

func TestPinnedHostKey(t *testing.T) {
	signer, key := newKey(t)
	s := startServer(t, signer.PublicKey())
	pinned := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.hostKey)))
	if c := exitCode(collect(t, execRequest{Conn: conn(t, s, key, pinned), Commands: []string{"true"}})); c != 0 {
		t.Fatalf("matching pinned key: exit %d", c)
	}
	other, _ := newKey(t)
	wrong := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(other.PublicKey())))
	evts := collect(t, execRequest{Conn: conn(t, s, key, wrong), Commands: []string{"true"}})
	last := evts[len(evts)-1]
	if last.T != "error" || last.Message != HostKeyChangedMessage || *last.Code != 255 {
		t.Fatalf("changed host key: %+v", last)
	}
}

func TestTimeout(t *testing.T) {
	signer, key := newKey(t)
	s := startServer(t, signer.PublicKey())
	if c := exitCode(collect(t, execRequest{Conn: conn(t, s, key, ""), Commands: []string{"sleep 5"}, Timeout: 1})); c != 124 {
		t.Fatalf("timeout exit = %d", c)
	}
}

func TestUpload(t *testing.T) {
	signer, key := newKey(t)
	s := startServer(t, signer.PublicKey())
	dir := t.TempDir()
	path := filepath.Join(dir, "it's here.txt")
	code, _, err := runUpload(context.Background(), uploadRequest{Conn: conn(t, s, key, ""), Path: path, ContentBase64: base64.StdEncoding.EncodeToString([]byte("hello\n")), Mode: "0600"})
	if err != nil || code != 0 {
		t.Fatalf("upload: %d %v", code, err)
	}
	b, _ := os.ReadFile(path)
	st, _ := os.Stat(path)
	if string(b) != "hello\n" || st.Mode().Perm() != 0o600 {
		t.Fatalf("content %q mode %v", b, st.Mode().Perm())
	}
}

func TestBatchInputAndShellCommand(t *testing.T) {
	if BatchInput([]string{"a", "b"}) != "a\nb\n" {
		t.Fatal("batch input")
	}
	if RemoteShellCommand != `sh -c "if command -v bash >/dev/null 2>&1; then exec bash -se; else exec sh -se; fi"` {
		t.Fatal("remote shell command")
	}
	if shellQuote("it's") != `'it'\''s'` {
		t.Fatal("quote")
	}
}
