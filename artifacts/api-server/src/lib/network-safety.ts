import { isIP, type LookupFunction } from "node:net";
import type { LookupAddress } from "node:dns";

function ipv4IsPrivate(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function ipv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const dotted = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const [a, b, c, d] = dotted[1]!.split(".").map(Number);
    normalized = normalized.replace(dotted[1]!, `${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`);
  }
  const pieces = normalized.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0]!.split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1]!.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return ipv4IsPrivate(address);
  if (version !== 6) return true;

  const words = ipv6Words(address);
  if (!words) return true;
  const allZeroPrefix = words.slice(0, 5).every((word) => word === 0);
  if (allZeroPrefix && words[5] === 0xffff) {
    const mappedIpv4 = [
      words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff,
    ].join(".");
    return ipv4IsPrivate(mappedIpv4);
  }
  const first = words[0]!;
  const second = words[1]!;
  const unspecified = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  return unspecified || loopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    (first & 0xe000) !== 0x2000 ||
    (first === 0x2001 && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    (first === 0x0064 && second === 0xff9b);
}

export function createPinnedWebhookLookup(address: LookupAddress): LookupFunction {
  return (( _hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    if (options && typeof options === "object" && "all" in options && options.all) {
      callback(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  }) as LookupFunction;
}