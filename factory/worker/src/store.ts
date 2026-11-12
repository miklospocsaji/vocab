/**
 * The artifact store between the worker and the build container (add-build-roles design.md):
 * `get`, `put` and `exists` on text bodies under keys such as
 * `work-items/<changeId>/tasks/<taskId>/<role>/<attempt>/<file>`. `FsStore` maps keys under a
 * directory, for local runs and tests; `S3Store` is the cloud's bucket (add-build-loop). Both
 * refuse a key that could leave its root: empty, absolute, with an empty, `.` or `..` segment, or
 * with a backslash.
 */
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export interface ArtifactStore {
  /** Rejects when the key does not exist. */
  get(key: string): Promise<string>;
  put(key: string, body: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class InvalidStoreKey extends Error {
  override readonly name = "InvalidStoreKey";

  constructor(key: string) {
    super(`invalid artifact store key ${JSON.stringify(key)}`);
  }
}

/** The key, if it is a relative path of plain segments; throws InvalidStoreKey otherwise. */
export function checkKey(key: string): string {
  const segments = key.split("/");
  if (key === "" || key.includes("\\") || key.includes("\0") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new InvalidStoreKey(key);
  }
  return key;
}

export class FsStore implements ArtifactStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async get(key: string): Promise<string> {
    const path = this.#path(key);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no artifact at ${key}`, { cause: error });
      throw error;
    }
  }

  async put(key: string, body: string): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Written aside, then renamed: a reader never sees half a file.
    const partial = `${path}.partial`;
    await writeFile(partial, body);
    await rename(partial, path);
  }

  async exists(key: string): Promise<boolean> {
    const path = this.#path(key);
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  #path(key: string): string {
    return join(this.root, checkKey(key));
  }
}

/** The part of `S3Client` the store uses, so tests can pass a fake. */
export interface S3Sender {
  send(command: GetObjectCommand | PutObjectCommand | HeadObjectCommand): Promise<unknown>;
}

export class S3Store implements ArtifactStore {
  readonly bucket: string;
  readonly #client: S3Sender;

  constructor(options: { bucket: string; client: S3Sender }) {
    this.bucket = options.bucket;
    this.#client = options.client;
  }

  async get(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: checkKey(key) });
    let output: unknown;
    try {
      output = await this.#client.send(command);
    } catch (error) {
      if (isNotFound(error)) throw new Error(`no artifact at ${key}`, { cause: error });
      throw error;
    }
    const body = (output as { Body?: { transformToString?: () => Promise<string> } }).Body;
    if (typeof body?.transformToString !== "function") throw new Error(`the artifact at ${key} has no body`);
    return body.transformToString();
  }

  async put(key: string, body: string): Promise<void> {
    await this.#client.send(new PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key), Body: body }));
  }

  async exists(key: string): Promise<boolean> {
    const command = new HeadObjectCommand({ Bucket: this.bucket, Key: checkKey(key) });
    try {
      await this.#client.send(command);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

/** S3's missing-key errors: `NoSuchKey` from GetObject, `NotFound` from HeadObject, or a 404. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return name === "NoSuchKey" || name === "NotFound" || $metadata?.httpStatusCode === 404;
}
