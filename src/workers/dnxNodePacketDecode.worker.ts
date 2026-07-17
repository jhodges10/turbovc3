import { parentPort } from "node:worker_threads";
import type { DnxPacketWorkerRequest, DnxPacketWorkerResponse } from "../dnxDecoderWorkerProtocol.js";

const port = parentPort;
if (!port) {
  throw new Error("The DNx Node packet worker requires a parent port.");
}

const queued: DnxPacketWorkerRequest[] = [];
type PacketHandler = (event: MessageEvent<DnxPacketWorkerRequest>) => void;
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<DnxPacketWorkerRequest>) => void) | null;
  postMessage(message: DnxPacketWorkerResponse, transfer?: Transferable[]): void;
};
scope.onmessage = null;
scope.postMessage = (message, transfer = []) => port.postMessage(message, transfer as never[]);
port.on("message", (message: DnxPacketWorkerRequest) => {
  const handler = Reflect.get(scope, "onmessage") as PacketHandler | null;
  if (handler) {
    handler({ data: message } as MessageEvent<DnxPacketWorkerRequest>);
  } else {
    queued.push(message);
  }
});

await import("./dnxPacketDecode.worker.js");
for (const message of queued.splice(0)) {
  const handler = Reflect.get(scope, "onmessage") as PacketHandler | null;
  handler?.({ data: message } as MessageEvent<DnxPacketWorkerRequest>);
}
