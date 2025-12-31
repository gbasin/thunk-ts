import os from "os";
import { describe, expect, it } from "bun:test";

import { getLocalIP } from "../src/server/network";

describe("getLocalIP", () => {
  it("prefers candidate interfaces and skips link-local addresses", () => {
    const originalHost = process.env.THUNK_HOST;
    if (originalHost !== undefined) {
      delete process.env.THUNK_HOST;
    }
    const originalInterfaces = os.networkInterfaces;
    os.networkInterfaces = () =>
      ({
        "Wi-Fi": [
          {
            address: "169.254.10.20",
            family: "IPv4",
            internal: false,
          } as os.NetworkInterfaceInfo,
          {
            address: "192.168.1.25",
            family: "IPv4",
            internal: false,
          } as os.NetworkInterfaceInfo,
        ],
        eth0: [
          {
            address: "10.0.0.5",
            family: "IPv4",
            internal: false,
          } as os.NetworkInterfaceInfo,
        ],
        lo: [
          {
            address: "127.0.0.1",
            family: "IPv4",
            internal: true,
          } as os.NetworkInterfaceInfo,
        ],
      }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

    try {
      expect(getLocalIP()).toBe("10.0.0.5");
    } finally {
      os.networkInterfaces = originalInterfaces;
      if (originalHost === undefined) {
        delete process.env.THUNK_HOST;
      } else {
        process.env.THUNK_HOST = originalHost;
      }
    }
  });

  it("returns localhost when no external IPv4 addresses exist", () => {
    const originalHost = process.env.THUNK_HOST;
    if (originalHost !== undefined) {
      delete process.env.THUNK_HOST;
    }
    const originalInterfaces = os.networkInterfaces;
    os.networkInterfaces = () =>
      ({
        docker0: [
          {
            address: "172.17.0.1",
            family: "IPv4",
            internal: false,
          } as os.NetworkInterfaceInfo,
        ],
        lo: [
          {
            address: "127.0.0.1",
            family: "IPv4",
            internal: true,
          } as os.NetworkInterfaceInfo,
        ],
        utun2: [
          {
            address: "10.8.0.2",
            family: "IPv4",
            internal: false,
          } as os.NetworkInterfaceInfo,
        ],
      }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

    try {
      expect(getLocalIP()).toBe("localhost");
    } finally {
      os.networkInterfaces = originalInterfaces;
      if (originalHost === undefined) {
        delete process.env.THUNK_HOST;
      } else {
        process.env.THUNK_HOST = originalHost;
      }
    }
  });
});
