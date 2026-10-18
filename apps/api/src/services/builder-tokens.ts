import { createHash } from 'node:crypto';

/** Same hashing as the gateway's lookup. Only the hash is stored. */
export const hashBuilderToken = (token: string) => createHash('sha256').update(token).digest('hex');
