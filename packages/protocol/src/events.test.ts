import { describe, expect, it } from 'vitest';
import { MAX_TOPICS_PER_STREAM, parseTopics, repoTopic } from './events';

const ID = '0192f1a2-3b4c-7d5e-8f60-123456789abc';

describe('parseTopics', () => {
  it('accepts the four topic kinds and drops duplicates', () => {
    expect(parseTopics(`repo:${ID}, user:${ID},org,org:admin,org`)).toEqual([
      `repo:${ID}`,
      `user:${ID}`,
      'org',
      'org:admin',
    ]);
  });

  it('rejects unknown topics, empty lists and too many topics', () => {
    expect(() => parseTopics('task:abc')).toThrow();
    expect(() => parseTopics(' , ')).toThrow(/at least one/);
    const many = Array.from(
      { length: MAX_TOPICS_PER_STREAM + 1 },
      (_, i) => `repo:${ID.slice(0, -2)}${String(i).padStart(2, '0')}`,
    ).join(',');
    expect(() => parseTopics(many)).toThrow(/at most/);
  });

  it('builds topics only from real ids', () => {
    expect(repoTopic(ID)).toBe(`repo:${ID}`);
    expect(() => repoTopic('not-an-id')).toThrow();
  });
});
