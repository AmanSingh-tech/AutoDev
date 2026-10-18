import './webcrypto-polyfill';
import { encode } from '@auth/core/jwt';
import { describe, expect, it } from 'vitest';
import { readSession } from './session';

const secret = 'x'.repeat(48);

describe('readSession', () => {
  it('decodes an Auth.js session cookie', async () => {
    const token = await encode({ token: { uid: 'u-1' }, secret, salt: 'authjs.session-token' });
    expect(await readSession({ 'authjs.session-token': token }, secret)).toEqual({ userId: 'u-1' });
  });

  it('decodes the __Secure- cookie used over HTTPS', async () => {
    const name = '__Secure-authjs.session-token';
    const token = await encode({ token: { uid: 'u-2' }, secret, salt: name });
    expect(await readSession({ [name]: token }, secret)).toEqual({ userId: 'u-2' });
  });

  it('rejects a token signed with another secret, or a missing cookie', async () => {
    const token = await encode({ token: { uid: 'u-1' }, secret: 'y'.repeat(48), salt: 'authjs.session-token' });
    expect(await readSession({ 'authjs.session-token': token }, secret)).toBeNull();
    expect(await readSession({}, secret)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await encode({ token: { uid: 'u-1' }, secret, salt: 'authjs.session-token', maxAge: -60 });
    expect(await readSession({ 'authjs.session-token': token }, secret)).toBeNull();
  });
});
