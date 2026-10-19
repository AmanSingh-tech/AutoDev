import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { compress, decompress, sha256, toBuffer, verified, type BlobStore } from './types';

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  forcePathStyle?: boolean;
}

const PREFIX = 'blobs/';
const keyOf = (hash: string) => `${PREFIX}${hash.slice(0, 2)}/${hash}`;
const hashOf = (key: string) => key.slice(key.lastIndexOf('/') + 1);

/**
 * Any S3-compatible bucket (MinIO in docker-compose). Objects are named by hash, gzipped on write,
 * and checked against their hash on read.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;

  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region ?? 'us-east-1',
      forcePathStyle: opts.forcePathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Keeps the SDK from adding checksum trailers that some S3-compatible servers reject.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(body: Buffer | string) {
    const raw = toBuffer(body);
    const hash = sha256(raw);
    const Key = keyOf(hash);
    if (await this.exists(Key)) return hash;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key,
        Body: await compress(raw),
        ContentEncoding: 'gzip',
        ContentType: 'application/octet-stream',
      }),
    );
    return hash;
  }

  async get(hash: string) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: keyOf(hash) }),
      );
      const compressed = Buffer.from(await res.Body!.transformToByteArray());
      return verified(hash, await decompress(compressed));
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }

  async *list() {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          Prefix: PREFIX,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key && o.LastModified) yield { hash: hashOf(o.Key), createdAt: o.LastModified };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async delete(hash: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: keyOf(hash) }));
  }

  private async exists(Key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key }));
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return false;
      throw e;
    }
  }
}
