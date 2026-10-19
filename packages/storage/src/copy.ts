import { BlobIntegrityError, type BlobStore } from './types';

export interface CopyReport {
  scanned: number;
  copied: number;
  missing: number;
}

/**
 * Copies every blob from one store to another and checks each copy by reading it back.
 * Blobs are named by hash, so a second run skips anything already there and is safe to repeat.
 */
export async function copyBlobs(
  from: BlobStore,
  to: BlobStore,
  onProgress?: (r: CopyReport) => void,
): Promise<CopyReport> {
  const report: CopyReport = { scanned: 0, copied: 0, missing: 0 };
  for await (const { hash } of from.list()) {
    report.scanned++;
    const bytes = await from.get(hash);
    if (!bytes) {
      report.missing++;
      continue;
    }
    const stored = await to.put(bytes);
    const back = await to.get(stored);
    if (stored !== hash || !back || !back.equals(bytes)) throw new BlobIntegrityError(hash);
    report.copied++;
    onProgress?.(report);
  }
  return report;
}
