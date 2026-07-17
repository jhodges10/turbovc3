import { parentPort } from "node:worker_threads";
import type { DnxSharedRowWorkerRequest, DnxSharedRowWorkerResponse } from "../dnxSharedRowWorkerProtocol.js";

const port = parentPort;
if (!port) {
  throw new Error("The DNx Node shared-row worker requires a parent port.");
}

const queued: DnxSharedRowWorkerRequest[] = [];
type SharedRowHandler = (event: MessageEvent<DnxSharedRowWorkerRequest>) => void;
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<DnxSharedRowWorkerRequest>) => void) | null;
  postMessage(message: DnxSharedRowWorkerResponse): void;
};
scope.onmessage = null;
scope.postMessage = (message) => port.postMessage(message);
port.on("message", (message: DnxSharedRowWorkerRequest) => {
  const handler = Reflect.get(scope, "onmessage") as SharedRowHandler | null;
  if (handler) {
    handler({ data: message } as MessageEvent<DnxSharedRowWorkerRequest>);
  } else {
    queued.push(message);
  }
});

await import("./dnxSharedRowDecode.worker.js");
for (const message of queued.splice(0)) {
  const handler = Reflect.get(scope, "onmessage") as SharedRowHandler | null;
  handler?.({ data: message } as MessageEvent<DnxSharedRowWorkerRequest>);
}
