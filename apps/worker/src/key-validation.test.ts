import { describe, expect, it, vi } from 'vitest';
import { createKeyValidationProcessor } from './key-validation';

describe('key-validation processor', () => {
  it('delegates to the credential service', async () => {
    const revalidateAll = vi.fn(async () => ({ checked: 2, invalidated: 1, restored: 0 }));
    await expect(createKeyValidationProcessor({ revalidateAll })()).resolves.toEqual({ checked: 2, invalidated: 1, restored: 0 });
  });
});
