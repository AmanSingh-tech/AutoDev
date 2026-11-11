import { z } from 'zod';
import { autodevConfig } from './autodev-yml';

/**
 * Builder ⇄ gateway messages over one outbound WebSocket (the builder never opens a port).
 * The 7 core types come from the spec; job.cancel lets a cancelled task stop a running job.
 */
export const PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const OFFLINE_AFTER_MS = 60_000;
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;

const id = z.string().uuid();

export const limits = z.object({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(262_144),
  timeoutMin: z.number().int().positive().max(30),
  /** Build and test run without network; setup (dependency install) gets network. */
  networkInSetupOnly: z.boolean(),
});
export type Limits = z.infer<typeof limits>;

// builder → gateway
export const helloFromBuilder = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  cliVersion: z.string().max(50),
  os: z.string().max(50),
  arch: z.string().max(50),
  dockerAvailable: z.boolean(),
  /** A job the builder was running when it lost the connection, if any. */
  runningJobId: id.nullable(),
  /** The Claude Code version found on this machine (null: none), for agent jobs. */
  claudeCode: z.string().max(50).nullable().optional(),
});
export const jobAccept = z.object({ type: z.literal('job.accept'), jobId: id });
export const jobReject = z.object({ type: z.literal('job.reject'), jobId: id, reason: z.enum(['busy', 'docker_unavailable', 'claude_unavailable', 'repo_unavailable', 'invalid_offer', 'shutting_down']), message: z.string().max(2000).optional() });
export const logChunk = z.object({
  type: z.literal('log.chunk'),
  jobId: id,
  seq: z.number().int().nonnegative(),
  step: z.enum(['system', 'setup', 'build', 'test']),
  stream: z.enum(['stdout', 'stderr', 'system']),
  data: z.string().max(64 * 1024),
});
export const failedTest = z.object({ name: z.string().max(500), file: z.string().max(500).optional(), message: z.string().max(2000).optional() });
export const jobResult = z.object({
  type: z.literal('job.result'),
  jobId: id,
  status: z.enum(['passed', 'failed', 'timed_out', 'error']),
  /** The step that decided the result (the first failing one, or test). */
  step: z.enum(['system', 'setup', 'build', 'test']),
  exitCode: z.number().int().nullable(),
  failedTests: z.array(failedTest).max(100),
  durationMs: z.number().int().nonnegative(),
  /** Last part of the deciding step's output, for the agent to fix from. */
  logTail: z.string().max(40_000),
  error: z.string().max(2000).optional(),
});
export const heartbeat = z.object({ type: z.literal('heartbeat'), ts: z.number() });

// ---- Agent jobs: one agent phase run by the builder owner's own Claude Code ----
export const MAX_AGENT_TEXT = 200_000;
export const MAX_AGENT_FILES = 300;
/** All returned file contents together. The gateway accepts messages up to 12 MB. */
export const MAX_AGENT_FILES_BYTES = 8 * 1024 * 1024;
export const agentPhase = z.enum(['plan', 'lld', 'code', 'fix']);

/** A line for the task page while Claude Code works: what it said, or the tool it used. */
export const agentEvent = z.object({
  type: z.literal('agent.event'),
  jobId: id,
  seq: z.number().int().nonnegative(),
  kind: z.enum(['text', 'tool']),
  toolName: z.string().max(100).optional(),
  text: z.string().max(8000),
});
export const agentUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});
export const agentResult = z.object({
  type: z.literal('agent.result'),
  jobId: id,
  status: z.enum(['done', 'error', 'timed_out', 'cancelled']),
  /** Claude Code's final message: the plan or design document, or a summary of the change. */
  text: z.string().max(MAX_AGENT_TEXT),
  /** Every file that differs from baseSha afterwards (text only). content null = deleted. */
  files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().nullable() })).max(MAX_AGENT_FILES),
  usage: agentUsage,
  turns: z.number().int().nonnegative(),
  model: z.string().max(100).nullable(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().max(2000).optional(),
  /** Why it could not run, so the task can say what to do about it. */
  errorKind: z.enum(['not_installed', 'not_signed_in', 'usage_limit', 'too_large', 'other']).optional(),
});

export const builderMessage = z.discriminatedUnion('type', [helloFromBuilder, jobAccept, jobReject, logChunk, jobResult, agentEvent, agentResult, heartbeat]);
export type BuilderMessage = z.infer<typeof builderMessage>;

// gateway → builder
export const helloFromGateway = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  builderId: id,
  heartbeatIntervalMs: z.number().int().positive(),
});
export const jobOffer = z.object({
  type: z.literal('job.offer'),
  jobId: id,
  taskKey: z.string(),
  repo: z.object({ fullName: z.string(), cloneUrl: z.string().url(), localPath: z.string().nullable() }),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
  /** Unified diff against baseSha (git apply). */
  patch: z.string().max(MAX_PATCH_BYTES),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** From the BASE branch. Never from the patch. */
  config: autodevConfig,
  docker: z.boolean(),
  dockerImage: z.string(),
  limits,
});
export const jobCancel = z.object({ type: z.literal('job.cancel'), jobId: id });
export const agentOffer = z.object({
  type: z.literal('agent.offer'),
  jobId: id,
  taskKey: z.string(),
  repo: z.object({ fullName: z.string(), cloneUrl: z.string().url(), localPath: z.string().nullable() }),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
  /** The task's changes so far (git apply), so a fix continues from the current code. */
  patch: z.string().max(MAX_PATCH_BYTES),
  patchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  phase: agentPhase,
  /** AutoDev's rules for this phase, appended to Claude Code's own system prompt. */
  system: z.string().max(MAX_AGENT_TEXT),
  /** The task, with the approved documents and any review comments or failing tests. */
  prompt: z.string().max(400_000),
  /** False for plan and design: Claude Code gets read-only tools. */
  allowEdits: z.boolean(),
  timeoutMin: z.number().int().positive().max(120),
});

export const gatewayMessage = z.discriminatedUnion('type', [helloFromGateway, jobOffer, agentOffer, jobCancel, heartbeat]);
export type GatewayMessage = z.infer<typeof gatewayMessage>;
export type JobOffer = z.infer<typeof jobOffer>;
export type AgentOffer = z.infer<typeof agentOffer>;
export type AgentResult = z.infer<typeof agentResult>;
export type AgentEvent = z.infer<typeof agentEvent>;
export type JobResult = z.infer<typeof jobResult>;
export type FailedTest = z.infer<typeof failedTest>;

export function parseBuilderMessage(raw: string): BuilderMessage | null {
  try {
    const res = builderMessage.safeParse(JSON.parse(raw));
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export function parseGatewayMessage(raw: string): GatewayMessage | null {
  try {
    const res = gatewayMessage.safeParse(JSON.parse(raw));
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}
