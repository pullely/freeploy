import { test } from "node:test";
import assert from "node:assert/strict";
import { composeUrl, detectPathStyleEndpoint, splitUrl } from "../src/lib/domain-url.ts";

test("DomainUrlParts::compose(): http or https, the port when given, a path with its slash", () => {
  assert.equal(composeUrl({ scheme: "https", host: " s3.example.com ", port: "", path: "" }), "https://s3.example.com");
  assert.equal(composeUrl({ scheme: "HTTP", host: "minio", port: "9000", path: "storage/v1/s3" }), "http://minio:9000/storage/v1/s3");
  assert.equal(composeUrl({ scheme: "ftp", host: "h", port: " ", path: "?x=1" }), "https://h?x=1");
  assert.equal(composeUrl({ scheme: "https", host: "", port: "", path: "" }), "https://");
});

test("DomainUrlParts::split(): the parts of a URL with a host, else empty parts", () => {
  assert.deepEqual(splitUrl("http://minio:9000/storage/v1/s3?x=1#f"), { scheme: "http", host: "minio", port: "9000", path: "/storage/v1/s3?x=1#f" });
  assert.deepEqual(splitUrl("HTTPS://S3.Example.com"), { scheme: "https", host: "S3.Example.com", port: "", path: "" });
  assert.deepEqual(splitUrl("sftp://box"), { scheme: "https", host: "box", port: "", path: "" });
  assert.deepEqual(splitUrl(null), { scheme: "https", host: "", port: "", path: "" });
  assert.deepEqual(splitUrl("not a url"), { scheme: "https", host: "", port: "", path: "" });
});

test("detectPathStyleEndpoint(): virtual-hosted style for the providers that reject path-style URLs", () => {
  assert.equal(detectPathStyleEndpoint("https://oss-cn-hangzhou.aliyuncs.com"), false);
  assert.equal(detectPathStyleEndpoint("https://cos.ap-guangzhou.myqcloud.com"), false);
  assert.equal(detectPathStyleEndpoint("https://s3.amazonaws.com"), true);
  assert.equal(detectPathStyleEndpoint("https://aliyuncs.com.example.org"), true);
});
