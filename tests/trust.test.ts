import { describe, expect, it } from "bun:test";

import { isTrustedIp } from "../src/server/trust";

describe("isTrustedIp", () => {
  it("matches IPv4 CIDR ranges", () => {
    expect(isTrustedIp("192.168.1.10", ["192.168.0.0/16"])).toBe(true);
    expect(isTrustedIp("10.0.5.5", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedIp("172.16.0.1", ["172.16.0.0/12"])).toBe(true);
    expect(isTrustedIp("8.8.8.8", ["10.0.0.0/8"])).toBe(false);
  });

  it("accepts IPv6 loopback and IPv4-mapped addresses", () => {
    expect(isTrustedIp("::1", ["127.0.0.0/8"])).toBe(true);
    expect(isTrustedIp("::ffff:127.0.0.1", ["127.0.0.0/8"])).toBe(true);
  });

  it("handles invalid inputs and CIDRs", () => {
    expect(isTrustedIp(null, ["127.0.0.0/8"])).toBe(false);
    expect(isTrustedIp("not-an-ip", ["127.0.0.0/8"])).toBe(false);
    expect(isTrustedIp("127.0.0.1", ["bad-cidr"])).toBe(false);
    expect(isTrustedIp("127.0.0.1", ["127.0.0.0/33"])).toBe(false);
  });
});
