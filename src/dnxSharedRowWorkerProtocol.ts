import type { DnxFrameHeader } from "./dnxFrame.js";

export type DnxSharedRowWorkerRequest =
  | { type: "init" }
  | {
      type: "decode-row";
      requestId: number;
      packet: SharedArrayBuffer;
      frame: SharedArrayBuffer;
      rowStart: number;
      rowEnd: number;
      row: number;
      header: DnxFrameHeader;
    }
  | { type: "close" };

export type DnxSharedRowWorkerResponse =
  | { type: "ready"; mode: string }
  | { type: "decoded-row"; requestId: number }
  | { type: "error"; requestId?: number; message: string };
