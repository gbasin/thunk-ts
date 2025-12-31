import net from "net";
import os from "os";

const IP_CANDIDATES = ["en0", "eth0", "en1", "wlan0", "Wi-Fi"];
const SKIP_PREFIXES = ["docker", "br-", "veth", "lo", "vmnet", "utun"];

export function getLocalIP(): string {
  const override = process.env.THUNK_HOST?.trim();
  if (override) {
    return override;
  }

  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces);
  const ordered = [
    ...IP_CANDIDATES.filter((name) => names.includes(name)),
    ...names.filter((name) => !IP_CANDIDATES.includes(name)),
  ];

  for (const name of ordered) {
    if (SKIP_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    const entries = interfaces[name] ?? [];
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      if (entry.address.startsWith("169.254.")) {
        continue;
      }
      return entry.address;
    }
  }

  return "localhost";
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      resolve(false);
    });
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(
  start: number,
  options: { isAvailable?: (port: number) => Promise<boolean> } = {},
): Promise<number> {
  const check = options.isAvailable ?? isPortAvailable;
  const maxAttempts = 100;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = start + offset;
    if (await check(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting at ${start}`);
}
