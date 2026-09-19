import { describe, expect, it } from "vitest";
import { hmacSha256, randomToken, sha256 } from "../src/crypto";

describe("crypto", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("signs with HMAC-SHA256", async () => {
    expect(await hmacSha256("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("makes random 64-character hex tokens", () => {
    const a = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(a);
  });
});
