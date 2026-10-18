import { and, eq, schema, sql, type SystemDb } from '@autodev/db';

export interface OverlayEntry {
  path: string;
  op: 'create' | 'modify' | 'delete';
  baseBlobSha: string | null;
  content: string | null;
}

/** Persistence for the workspace overlay. Every write bumps the workspace revision. */
export interface OverlayStore {
  list(): Promise<OverlayEntry[]>;
  get(path: string): Promise<OverlayEntry | null>;
  put(entry: OverlayEntry): Promise<void>;
  remove(path: string): Promise<void>;
  revision(): Promise<number>;
}

export class PgOverlayStore implements OverlayStore {
  constructor(
    private readonly sys: SystemDb,
    private readonly workspaceId: string,
    private readonly orgId: string,
  ) {}

  async list() {
    return this.sys
      .select({ path: schema.workspaceFiles.path, op: schema.workspaceFiles.op, baseBlobSha: schema.workspaceFiles.baseBlobSha, content: schema.workspaceFiles.content })
      .from(schema.workspaceFiles)
      .where(eq(schema.workspaceFiles.workspaceId, this.workspaceId));
  }

  async get(path: string) {
    const [row] = await this.sys
      .select({ path: schema.workspaceFiles.path, op: schema.workspaceFiles.op, baseBlobSha: schema.workspaceFiles.baseBlobSha, content: schema.workspaceFiles.content })
      .from(schema.workspaceFiles)
      .where(and(eq(schema.workspaceFiles.workspaceId, this.workspaceId), eq(schema.workspaceFiles.path, path)));
    return row ?? null;
  }

  async put(e: OverlayEntry) {
    await this.sys.transaction(async (tx) => {
      await tx
        .insert(schema.workspaceFiles)
        .values({ workspaceId: this.workspaceId, orgId: this.orgId, ...e })
        .onConflictDoUpdate({ target: [schema.workspaceFiles.workspaceId, schema.workspaceFiles.path], set: { op: e.op, content: e.content, baseBlobSha: e.baseBlobSha } });
      await this.bump(tx);
    });
  }

  async remove(path: string) {
    await this.sys.transaction(async (tx) => {
      await tx.delete(schema.workspaceFiles).where(and(eq(schema.workspaceFiles.workspaceId, this.workspaceId), eq(schema.workspaceFiles.path, path)));
      await this.bump(tx);
    });
  }

  async revision() {
    const [w] = await this.sys.select({ r: schema.workspaces.revision }).from(schema.workspaces).where(eq(schema.workspaces.id, this.workspaceId));
    return w?.r ?? 0;
  }

  private bump(tx: Parameters<Parameters<SystemDb['transaction']>[0]>[0]) {
    return tx.update(schema.workspaces).set({ revision: sql`${schema.workspaces.revision} + 1` }).where(eq(schema.workspaces.id, this.workspaceId));
  }
}

export class MemoryOverlayStore implements OverlayStore {
  readonly entries = new Map<string, OverlayEntry>();
  rev = 0;
  async list() {
    return [...this.entries.values()];
  }
  async get(path: string) {
    return this.entries.get(path) ?? null;
  }
  async put(e: OverlayEntry) {
    this.entries.set(e.path, e);
    this.rev++;
  }
  async remove(path: string) {
    this.entries.delete(path);
    this.rev++;
  }
  async revision() {
    return this.rev;
  }
}
