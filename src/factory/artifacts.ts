import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface FactoryArtifactStore {
  /** Stores one artifact under `staging/<taskId>/<name>` and returns its key. */
  put(taskId: string, name: string, body: string, contentType: string): Promise<string>;
}

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function stagingKey(taskId: string, name: string): string {
  if (!ARTIFACT_NAME.test(name)) throw new Error(`Invalid artifact name: ${name}`);
  return `staging/${taskId}/${name}`;
}

export class S3FactoryArtifactStore implements FactoryArtifactStore {
  constructor(private readonly bucket: string, private readonly client = new S3Client({})) {}

  async put(taskId: string, name: string, body: string, contentType: string): Promise<string> {
    const key = stagingKey(taskId, name);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }
}
