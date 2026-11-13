// The artifact store (add-build-roles task 2.10): a directory for local runs and tests, S3 in the cloud.
// The store an environment names (add-build-loop task 4.1).
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsStore, InvalidStoreKey, S3Store, storeFromEnv, type ArtifactStore, type S3Sender } from "../src/store.ts";

const KEY = "work-items/add-sample/tasks/1.1/implementer/1/outcome.json";
const BAD_KEYS = ["", "../outside.json", "work-items/../../etc/passwd", "work-items/a/..", "/absolute.json", "work-items//double.json", "work-items\\windows.json"];

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vocab-store-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake S3 client: objects in a map, and every command it was sent. */
class FakeS3 implements S3Sender {
  readonly objects = new Map<string, string>();
  readonly sent: (GetObjectCommand | PutObjectCommand | HeadObjectCommand)[] = [];

  send(command: GetObjectCommand | PutObjectCommand | HeadObjectCommand): Promise<unknown> {
    this.sent.push(command);
    const { Bucket, Key } = command.input;
    const id = `${Bucket ?? ""}/${Key ?? ""}`;
    if (command instanceof PutObjectCommand) {
      const body = command.input.Body;
      if (typeof body !== "string") return Promise.reject(new Error("the fake stores string bodies only"));
      this.objects.set(id, body);
      return Promise.resolve({});
    }
    const body = this.objects.get(id);
    if (body === undefined) {
      const error = Object.assign(new Error(command instanceof HeadObjectCommand ? "NotFound" : "The specified key does not exist."), {
        name: command instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
      return Promise.reject(error);
    }
    if (command instanceof HeadObjectCommand) return Promise.resolve({ ContentLength: body.length });
    return Promise.resolve({ Body: { transformToString: () => Promise.resolve(body) } });
  }
}

const stores: [string, () => ArtifactStore][] = [
  ["FsStore", () => new FsStore(root)],
  ["S3Store", () => new S3Store({ bucket: "factory-artifacts", client: new FakeS3() })],
];

describe.each(stores)("%s", (_name, make) => {
  it("gets what was put, under nested keys", async () => {
    const store = make();
    await store.put(KEY, '{"outcome":"passed"}\n');
    expect(await store.get(KEY)).toBe('{"outcome":"passed"}\n');
  });

  it("overwrites a key", async () => {
    const store = make();
    await store.put(KEY, "first");
    await store.put(KEY, "second");
    expect(await store.get(KEY)).toBe("second");
  });

  it("says whether a key exists", async () => {
    const store = make();
    expect(await store.exists(KEY)).toBe(false);
    await store.put(KEY, "x");
    expect(await store.exists(KEY)).toBe(true);
  });

  it("rejects a get of a missing key, naming it", async () => {
    await expect(make().get(KEY)).rejects.toThrow(KEY);
  });

  it.each(BAD_KEYS)("refuses the key %j", async (key) => {
    const store = make();
    await expect(store.put(key, "x")).rejects.toBeInstanceOf(InvalidStoreKey);
    await expect(store.get(key)).rejects.toBeInstanceOf(InvalidStoreKey);
    await expect(store.exists(key)).rejects.toBeInstanceOf(InvalidStoreKey);
  });
});

describe("FsStore", () => {
  it("maps keys to files under its root", async () => {
    await new FsStore(root).put(KEY, "x");
    expect(readFileSync(join(root, KEY), "utf8")).toBe("x");
  });

  it("writes nothing outside its root for a key with ..", async () => {
    const inner = join(root, "store");
    await expect(new FsStore(inner).put("../escaped.json", "x")).rejects.toBeInstanceOf(InvalidStoreKey);
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
  });
});

describe("S3Store", () => {
  it("sends Put, Get and Head commands for the bucket and key", async () => {
    const client = new FakeS3();
    const store = new S3Store({ bucket: "factory-artifacts", client });
    await store.put(KEY, "body");
    await store.get(KEY);
    await store.exists(KEY);

    expect(client.sent.map((command) => [command.constructor.name, command.input.Bucket, command.input.Key])).toEqual([
      ["PutObjectCommand", "factory-artifacts", KEY],
      ["GetObjectCommand", "factory-artifacts", KEY],
      ["HeadObjectCommand", "factory-artifacts", KEY],
    ]);
  });

  it("rethrows errors other than a missing key", async () => {
    const client: S3Sender = { send: () => Promise.reject(Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })) };
    const store = new S3Store({ bucket: "factory-artifacts", client });
    await expect(store.exists(KEY)).rejects.toThrow("Access Denied");
    await expect(store.get(KEY)).rejects.toThrow("Access Denied");
  });

  it("sends no command for a refused key", async () => {
    const client = new FakeS3();
    await expect(new S3Store({ bucket: "factory-artifacts", client }).put("../x", "x")).rejects.toBeInstanceOf(InvalidStoreKey);
    expect(client.sent).toEqual([]);
  });
});

describe("storeFromEnv", () => {
  it("is the directory FACTORY_STORE_DIR, as local runs mount it", () => {
    const store = storeFromEnv({ FACTORY_STORE_DIR: root });
    expect(store).toBeInstanceOf(FsStore);
    expect((store as FsStore).root).toBe(root);
  });

  it("is the bucket FACTORY_STORE_BUCKET in the cloud, through the given client", async () => {
    const client = new FakeS3();
    const store = storeFromEnv({ FACTORY_STORE_BUCKET: "factory-artifacts-123" }, () => client);
    expect(store).toBeInstanceOf(S3Store);
    expect((store as S3Store).bucket).toBe("factory-artifacts-123");
    await store?.put(KEY, "x");
    expect(client.sent.map((command) => command.input.Bucket)).toEqual(["factory-artifacts-123"]);
  });

  it("prefers the directory when both are set, and is undefined when neither is", () => {
    expect(storeFromEnv({ FACTORY_STORE_DIR: root, FACTORY_STORE_BUCKET: "factory-artifacts-123" }, () => new FakeS3())).toBeInstanceOf(FsStore);
    expect(storeFromEnv({})).toBeUndefined();
    expect(storeFromEnv({ FACTORY_STORE_DIR: "", FACTORY_STORE_BUCKET: " " })).toBeUndefined();
    // The old name of add-build-roles is not read.
    expect(storeFromEnv({ FACTORY_ARTIFACT_BUCKET: "factory-artifacts-123" })).toBeUndefined();
  });
});
