import { describe, expect, it } from "vitest";
import { hmacSha256, randomToken, sha256, uuidv7 } from "../src/crypto";

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

  it("makes UUID v7s that start with the current time", () => {
    const before = Date.now();
    const ids = Array.from({ length: 3 }, () => uuidv7());
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(Date.now());
    }
    expect(new Set(ids).size).toBe(3);
  });
});
