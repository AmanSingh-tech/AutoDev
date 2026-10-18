import { parse } from 'yaml';
import { z } from 'zod';

export const MAX_TIMEOUT_MIN = 30;
export const DEFAULT_DOCKER_IMAGE = 'node:22-bookworm';

const commands = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));

/**
 * .autodev.yml, read from the BASE branch only. The builder runs exactly these commands and nothing
 * else. A patch that edits this file needs the user's consent before any run.
 */
export const autodevConfig = z
  .object({
    setup: commands.optional(),
    build: commands.optional(),
    test: commands,
    timeout_min: z.number().int().min(1).max(MAX_TIMEOUT_MIN).default(15),
    docker_image: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?(@sha256:[a-f0-9]{64})?$/i, 'must be an image reference like node:22 or ghcr.io/org/img@sha256:…')
      .optional(),
    /** Free-text guidance for the agent (conventions, gotchas). Never executed. */
    notes: z.string().max(10_000).optional(),
  })
  .strict();

export type AutodevConfig = z.output<typeof autodevConfig>;

export type ConfigResult = { ok: true; config: AutodevConfig } | { ok: false; error: string };

export function parseAutodevConfig(source: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parse(source, { maxAliasCount: 50 });
  } catch (e) {
    return { ok: false, error: `.autodev.yml is not valid YAML: ${(e as Error).message}` };
  }
  const res = autodevConfig.safeParse(raw ?? {});
  if (!res.success) {
    return { ok: false, error: `.autodev.yml: ${res.error.issues.map((i) => `${i.path.join('.') || 'root'} ${i.message}`).join('; ')}` };
  }
  return { ok: true, config: res.data };
}

/** The commands in run order, by step. */
export function steps(c: AutodevConfig): { step: 'setup' | 'build' | 'test'; commands: string[] }[] {
  return [
    ...(c.setup ? [{ step: 'setup' as const, commands: c.setup }] : []),
    ...(c.build ? [{ step: 'build' as const, commands: c.build }] : []),
    { step: 'test' as const, commands: c.test },
  ];
}
