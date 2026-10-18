import { webcrypto } from 'node:crypto';

// Node 18 has no global WebCrypto, which @auth/core's JWT code needs. Delete once we're on Node 20+.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
