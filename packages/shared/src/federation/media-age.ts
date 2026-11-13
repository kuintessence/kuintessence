import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Official v1.3.2 release assets, verified against publisher GitHub release SHA-256 digests.
export const MEDIA_AGE_RELEASE = {
  version: "1.3.2",
  linux: {
    x64: {
      archive: "cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10",
      age: "eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c",
      "age-keygen": "0a0009db842259d6717f7eeb30acb6b90d2a2eb924c6acd0a0db0ca1f1537899",
    },
    arm64: {
      archive: "6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4",
      age: "41b072352f4561018949623c674d16ef704019b9108a9bbdbd21292efebfc94f",
      "age-keygen": "00b549cebf68302893fc489830f37e706712689ca877f84d85439d700d2997c7",
    },
  },
} as const;
const Recipient = /^age1[0-9a-z]{58}$/;
const Identity = /^AGE-SECRET-KEY-1[0-9A-Z]{58}\n?$/;

/** Linux-only official age process. Secrets use a private pipe, never argv, env or disk. */
export class MediaAge {
  constructor(private readonly binaryDirectory: string) {}

  async generateIdentity(signal: AbortSignal): Promise<{ recipient: string; identity: Buffer }> {
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const bytes of this.run("age-keygen", [], empty(), signal)) {
        length += bytes.length;
        if (length > 8192) throw new Error("MEDIA_AGE_KEY_INVALID");
        chunks.push(Buffer.from(bytes));
      }
      const text = Buffer.concat(chunks).toString("ascii");
      const recipient = text
        .split("\n")
        .find((line) => line.startsWith("# public key: "))
        ?.slice(14);
      const identity = text.split("\n").find((line) => line.startsWith("AGE-SECRET-KEY-"));
      if (!recipient || !Recipient.test(recipient) || !identity || !Identity.test(identity))
        throw new Error("MEDIA_AGE_KEY_INVALID");
      return { recipient, identity: Buffer.from(`${identity}\n`, "ascii") };
    } finally {
      for (const chunk of chunks) chunk.fill(0);
    }
  }

  async *encrypt(
    stream: AsyncIterable<Uint8Array>,
    recipient: string,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (!Recipient.test(recipient)) throw new Error("MEDIA_AGE_RECIPIENT_INVALID");
    const directory = await mkdtemp(join(tmpdir(), "kq-media-recipient-"));
    try {
      const recipientPath = join(directory, "recipient");
      // This file contains only the per-package public recipient, never its decryption key.
      await writeFile(recipientPath, `${recipient}\n`, { flag: "wx", mode: 0o600 });
      yield* this.run("age", ["--encrypt", "--recipients-file", recipientPath], stream, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async *decrypt(
    encryptedFile: string,
    identity: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (identity.byteLength > 128 || !Identity.test(Buffer.from(identity).toString("ascii")))
      throw new Error("MEDIA_AGE_IDENTITY_INVALID");
    const key = Buffer.from(identity);
    const handle = await open(
      encryptedFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error("MEDIA_CIPHERTEXT_INVALID");
      yield* this.run(
        "age",
        ["--decrypt", "--identity", "-", "/proc/self/fd/4"],
        Readable.from([key]),
        signal,
        handle.fd,
      );
    } finally {
      key.fill(0);
      await handle.close();
    }
  }

  private async *run(
    binary: "age" | "age-keygen",
    args: string[],
    input: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    inputFileDescriptor?: number,
  ): AsyncGenerator<Uint8Array> {
    signal.throwIfAborted();
    if (
      process.platform !== "linux" ||
      (process.arch !== "x64" && process.arch !== "arm64") ||
      !isAbsolute(this.binaryDirectory)
    )
      throw new Error("MEDIA_AGE_PLATFORM_UNSUPPORTED");
    const path = join(this.binaryDirectory, binary);
    if ((await realpath(path)) !== path) throw new Error("MEDIA_AGE_BINARY_INVALID");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > 32 * 1024 * 1024 ||
        (stat.mode & 0o022) !== 0 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.())
      )
        throw new Error("MEDIA_AGE_BINARY_INVALID");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== MEDIA_AGE_RELEASE.linux[process.arch][binary])
        throw new Error("MEDIA_AGE_BINARY_INVALID");
      signal.throwIfAborted();
      // Execute the same descriptor that was hashed; path replacement cannot change the binary.
      const child = spawn("/proc/self/fd/3", args, {
        stdio: ["pipe", "pipe", "ignore", handle.fd, inputFileDescriptor ?? "ignore"],
        env: { LANG: "C" },
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", () => reject(new Error("MEDIA_AGE_PROCESS_FAILED")));
        child.once("exit", resolve);
      });
      const stdin = child.stdin,
        stdout = child.stdout;
      if (!stdin || !stdout) {
        child.kill("SIGKILL");
        await exited;
        throw new Error("MEDIA_AGE_PROCESS_FAILED");
      }
      const abort = () => {
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      const writeInput = pipeline(Readable.from(input), stdin, { signal });
      // Attach error handlers immediately: a rejected feeder must stop a stalled consumer.
      const feeding = writeInput;
      void feeding.catch(abort);
      void exited.catch(abort);
      try {
        signal.throwIfAborted();
        for await (const chunk of stdout) {
          signal.throwIfAborted();
          yield new Uint8Array(chunk);
        }
        await feeding;
        if ((await exited) !== 0) throw new Error("MEDIA_AGE_AUTHENTICATION_FAILED");
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", abort);
        child.kill("SIGKILL");
        stdin.destroy();
        stdout.destroy();
        await Promise.allSettled([writeInput, exited]);
      }
    } finally {
      await handle.close();
    }
  }
}

async function* empty(): AsyncGenerator<Uint8Array> {}
