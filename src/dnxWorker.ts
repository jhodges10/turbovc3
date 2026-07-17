export type DnxWorkerKind = "packet" | "shared-row";

export interface DnxWorker {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type DnxWorkerFactory = (kind: DnxWorkerKind, moduleUrl: URL) => DnxWorker;
