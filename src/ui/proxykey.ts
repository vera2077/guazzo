/** Pure key for the live-preview proxy cache (AQ3, review round 8). */
export interface ProxyKeyInput {
  /** stable per-document number; tab switches change it even for equal sizes */
  docId: number;
  width: number;
  height: number;
  rect: { x: number; y: number; w: number; h: number };
  /** proxy scale, so a resized proxy never reuses a smaller one */
  scale: number;
  /** the document's monotonic content revision; never a bounded undo index */
  revision: number;
  layerCount: number;
  layerId: number;
  /** content stamp of the layer mask after the edit, 0 when there is none */
  maskStamp: number;
  /** structure change with no grid write: the mask polarity */
  maskHidden: boolean;
}

/**
 * The preview stack must be rebuilt whenever the pixels it was built from could
 * have changed. The old key used `history.position`, which saturates once the undo
 * budget starts evicting (increment then decrement of the same index), so previews
 * silently stopped tracking the document in exactly the long sessions where they
 * matter — and it ignored document identity and mask paintwork, which only worked
 * by accident.
 */
export function proxyKey(i: ProxyKeyInput): string {
  const { rect } = i;
  return [
    i.docId,
    `${i.width}x${i.height}`,
    `${rect.x},${rect.y},${rect.w},${rect.h}`,
    i.scale.toFixed(4),
    i.revision,
    i.layerCount,
    i.layerId,
    i.maskStamp,
    i.maskHidden,
  ].join(":");
}
