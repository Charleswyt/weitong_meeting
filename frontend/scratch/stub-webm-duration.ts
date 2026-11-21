// 桩：`finalizeWebmDuration` 要读 EBML 字节（浏览器侧那条补丁路），与"分片该不该被并成一份文件"无关。
// 这里给它**原样返回**：文件尺寸因此就是各片之和，断言里量的字节账仍然说实话。
// `webmInitHeaderBytes`（给无头续片补容器头）被测路径不走它，故抛。
export async function finalizeWebmDuration(blob: Blob): Promise<Blob> {
  return blob
}

export function webmInitHeaderBytes(): Uint8Array | null {
  throw new Error('桩被调用（webmInitHeaderBytes）：这条用例不该走到补容器头那一步')
}
