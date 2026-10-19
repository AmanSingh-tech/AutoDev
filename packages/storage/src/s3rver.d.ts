// s3rver ships no types. Only the parts the tests use are declared here.
declare module 's3rver' {
  export default class S3rver {
    constructor(options: Record<string, unknown>);
    run(): Promise<void>;
    close(): Promise<void>;
  }
}
