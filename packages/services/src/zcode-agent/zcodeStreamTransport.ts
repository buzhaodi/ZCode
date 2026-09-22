/**
 * 进程内流传输 —— 用 PassThrough 流对在同一个 Node 进程内连接
 * ZCodeProtocolClient（host 侧）和 runZCodeProtocolAgent（agent 侧）。
 *
 * 替代 ZCodeStdioTransport 的 stdio 管道，用于无法 spawn 子进程的场景
 * （nodejs-mobile / Android）。复用 NDJSON 帧格式，与 agent 侧的
 * ZCodeProtocolNdjsonConnection 完全兼容。
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { ZCodeProtocolMessage } from "@zcode/shared";
import { zcodeProtocolMessageSchema } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type {
  ZCodeProtocolTransport,
  ZCodeProtocolTransportClosedEvent,
} from "./zcodeProtocolTransport.js";

const log = createServiceLogger("zcode-agent-stream-transport");

export interface ZCodeStreamTransportOptions {
  onStderrLine?: (line: string) => void;
}

export class ZCodeStreamTransport implements ZCodeProtocolTransport {
  readonly kind = "memory" as const;

  private readonly messageEmitter = new Emitter<ZCodeProtocolMessage>();
  private readonly closeEmitter = new Emitter<ZCodeProtocolTransportClosedEvent>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private disposed = false;
  private closed = false;
  private disposeAndWaitPromise: Promise<void> | undefined;

  readonly onMessage = this.messageEmitter.event;
  readonly onClose = this.closeEmitter.event;

  /**
   * @param inputStream — agent 输出流（host 读取，即 agent 的 output 参数）
   * @param outputStream — agent 输入流（host 写入，即 agent 的 input 参数）
   */
  constructor(
    private readonly inputStream: Readable,
    private readonly outputStream: Writable,
    private readonly options?: ZCodeStreamTransportOptions,
  ) {
    // ZCode Protocol stdio 帧边界只认 LF（与 ZCodeStdioTransport 一致）
    inputStream.on("data", this.handleData);
    inputStream.once("end", this.handleEnd);
    inputStream.once("close", this.handleEnd);
    inputStream.on("error", (error) => {
      this.fireClose({ reason: `input_error: ${error.message}` });
    });
    outputStream.on("error", (error) => {
      this.fireClose({ reason: `output_error: ${error.message}` });
    });
  }

  async send(message: ZCodeProtocolMessage): Promise<void> {
    if (this.disposed || this.closed || this.outputStream.destroyed || !this.outputStream.writable) {
      throw new Error("ZCode agent stream transport is closed");
    }
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.outputStream.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeLocalResources();
  }

  disposeAndWait(): Promise<void> {
    if (!this.disposeAndWaitPromise) {
      this.disposeAndWaitPromise = this.disposeAndWaitOnce().finally(() => {
        if (this.disposeAndWaitPromise === this.disposeAndWaitPromise) {
          this.disposeAndWaitPromise = undefined;
        }
      });
    }
    return this.disposeAndWaitPromise;
  }

  private async disposeAndWaitOnce(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.disposeLocalResources();
    }
    // 向 agent 发送 EOF（关闭其输入流）
    this.requestClose();
    // 等待 agent 输出流关闭
    await this.waitForInputStreamEnd(1_500);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainFrames();
  };

  private readonly handleEnd = (): void => {
    this.buffer += this.decoder.end();
    const trailing = this.buffer;
    this.buffer = "";
    if (trailing.length > 0 && !this.closed) {
      this.handleFrame(trailing);
    }
    this.fireClose({ reason: "stream_closed" });
  };

  private drainFrames(): void {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const frame = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.handleFrame(frame);
      if (this.closed) return;
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private handleFrame(frame: string): void {
    const line = frame.endsWith("\r") ? frame.slice(0, -1) : frame;
    if (line.trim().length === 0) return;
    try {
      const parsed = zcodeProtocolMessageSchema.parse(JSON.parse(line));
      this.messageEmitter.fire(parsed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(undefined, "protocol frame parse error", { reason });
      this.fireClose({ reason: `protocol_parse_error: ${reason}` });
    }
  }

  private fireClose(event: ZCodeProtocolTransportClosedEvent): void {
    if (this.closed) return;
    this.closed = true;
    this.closeEmitter.fire(event);
  }

  private disposeLocalResources(): void {
    this.inputStream.off("data", this.handleData);
    this.inputStream.off("end", this.handleEnd);
    this.inputStream.off("close", this.handleEnd);
    this.messageEmitter.dispose();
    this.closeEmitter.dispose();
  }

  private requestClose(): void {
    if (this.outputStream.destroyed || !this.outputStream.writable) return;
    try {
      this.outputStream.once("error", () => undefined);
      this.outputStream.end();
    } catch {
      // agent 可能正好在 dispose 期间退出
    }
  }

  private waitForInputStreamEnd(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inputStream.off?.("end", settle);
        this.inputStream.off?.("close", settle);
        resolve();
      };
      this.inputStream.once("end", settle);
      this.inputStream.once("close", settle);
      const timer = setTimeout(settle, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  }
}
