export interface CodecBuildTarget {
  name: string;
  runtime: "wasm" | "webgpu" | "worker" | "native-tool";
  sourceRoot: string;
  outputRoot: string;
  status: "planned" | "experimental" | "generated";
  notes?: readonly string[];
}
