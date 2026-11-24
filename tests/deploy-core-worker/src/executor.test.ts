// The executor client and instant_remote_process's semantics (DP4).
import { execBatch, instantRemoteProcess, remoteErrorMessage, RemoteProcessError, HOST_KEY_CHANGED_MESSAGE, type ExecutorFetch } from "../../../apps/deploy-core-worker/src/executor";

const conn = { host: "10.0.0.5", port: 22, user: "root", privateKey: "KEY", hostKey: "" };
const stream = (lines: object[], chunkSize = 7): ExecutorFetch => async () => {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const enc = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < enc.length; i += chunkSize) c.enqueue(enc.slice(i, i + chunkSize));
        c.close();
      },
    }),
  );
};

describe("execBatch", () => {
  it("reassembles NDJSON split across chunks and reports lines as they come", async () => {
    const seen: string[] = [];
    const r = await execBatch(
      stream([{ t: "hostkey", key: "ssh-ed25519 AAA" }, { t: "out", line: "one" }, { t: "err", line: "warn" }, { t: "out", line: "two" }, { t: "exit", code: 0 }]),
      conn,
      ["echo one"],
      undefined,
      (s, l) => seen.push(`${s}:${l}`),
    );
    expect(r).toEqual({ stdout: ["one", "two"], stderr: ["warn"], exitCode: 0, hostKey: "ssh-ed25519 AAA", error: null });
    expect(seen).toEqual(["out:one", "err:warn", "out:two"]);
  });

  it("sends the batch and the timeout to /exec", async () => {
    let sent: { path: string; body: unknown } | null = null;
    const f: ExecutorFetch = async (path, init) => {
      sent = { path, body: JSON.parse(init.body) };
      return stream([{ t: "exit", code: 0 }])(path, init);
    };
    await execBatch(f, conn, ["a", "b"], 30);
    expect(sent).toEqual({ path: "/exec", body: { conn, commands: ["a", "b"], timeout: 30 } });
  });
});

describe("instantRemoteProcess", () => {
  it("trims the output and reads 'null' as null", async () => {
    expect((await instantRemoteProcess(stream([{ t: "out", line: "  hi " }, { t: "out", line: "" }, { t: "exit", code: 0 }]), conn, ["x"])).output).toBe("hi");
    expect((await instantRemoteProcess(stream([{ t: "out", line: "null" }, { t: "exit", code: 0 }]), conn, ["x"])).output).toBeNull();
  });

  it("throws excludeCertainErrors' message, or returns null when throwError is false", async () => {
    await expect(instantRemoteProcess(stream([{ t: "err", line: " boom " }, { t: "exit", code: 2 }]), conn, ["x"])).rejects.toThrow(new RemoteProcessError("boom", 2));
    await expect(instantRemoteProcess(stream([{ t: "exit", code: 3 }]), conn, ["x"])).rejects.toThrow("SSH command failed with exit code: 3");
    expect((await instantRemoteProcess(stream([{ t: "exit", code: 3 }]), conn, ["x"], { throwError: false })).output).toBeNull();
  });

  it("reports a changed host key with Coolify's message", async () => {
    await expect(instantRemoteProcess(stream([{ t: "error", code: 255, message: HOST_KEY_CHANGED_MESSAGE }]), conn, ["x"])).rejects.toThrow(HOST_KEY_CHANGED_MESSAGE);
    expect(remoteErrorMessage("Host key verification failed.\n", 255)).toBe(HOST_KEY_CHANGED_MESSAGE);
  });
});
