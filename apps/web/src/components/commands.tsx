/** Shows the exact commands a builder will run, by step. */
export function ConfigCommands({ config }: { config: unknown }) {
  const c = (config ?? {}) as { setup?: string[]; build?: string[]; test?: string[]; timeout_min?: number; docker_image?: string };
  const rows = (['setup', 'build', 'test'] as const).flatMap((step) => (c[step] ?? []).map((cmd) => ({ step, cmd })));
  if (!rows.length) return <p className="text-sm text-muted-foreground">No commands.</p>;
  return (
    <div className="space-y-1">
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
        {rows.map((r, i) => (
          <div key={i}>
            <span className="text-muted-foreground"># {r.step}</span>
            {'\n'}$ {r.cmd}
          </div>
        ))}
      </pre>
      <p className="text-xs text-muted-foreground">
        Image {c.docker_image ?? 'node:22-bookworm'} · up to {c.timeout_min ?? 15} min · no network outside setup
      </p>
    </div>
  );
}
