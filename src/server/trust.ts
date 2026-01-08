import net from "net";

type ParsedCidr = {
  base: number;
  mask: number;
};

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (num < 0 || num > 255) {
      return null;
    }
    value = (value << 8) | num;
  }
  return value >>> 0;
}

function parseCidr(entry: string): ParsedCidr | null {
  const [ipPart, maskPart] = entry.split("/");
  const ipValue = parseIpv4(ipPart);
  if (ipValue === null) {
    return null;
  }
  const maskBits = maskPart === undefined ? 32 : Number(maskPart);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) {
    return null;
  }
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return { base: ipValue & mask, mask };
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  const zoneIndex = trimmed.indexOf("%");
  return zoneIndex >= 0 ? trimmed.slice(0, zoneIndex) : trimmed;
}

function toIpv4(ip: string): string | null {
  const normalized = normalizeIp(ip);
  if (net.isIP(normalized) === 4) {
    return normalized;
  }
  if (normalized === "::1") {
    return "127.0.0.1";
  }
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    return normalized.slice("::ffff:".length);
  }
  return null;
}

export function isTrustedIp(ip: string | null, trustedCidrs: string[]): boolean {
  if (!ip) {
    return false;
  }
  const ipv4 = toIpv4(ip);
  if (!ipv4) {
    return false;
  }
  const ipValue = parseIpv4(ipv4);
  if (ipValue === null) {
    return false;
  }
  for (const entry of trustedCidrs) {
    const parsed = parseCidr(entry);
    if (!parsed) {
      continue;
    }
    if ((ipValue & parsed.mask) === parsed.base) {
      return true;
    }
  }
  return false;
}
