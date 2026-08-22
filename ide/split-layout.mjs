export const SPLIT_RATIO_KEY = 'sprout68k:workspace-split-ratio';
export const DEFAULT_SPLIT_RATIO = 0.56;
export const MIN_SPLIT_RATIO = 0.28;
export const MAX_SPLIT_RATIO = 0.72;

export function clampSplitRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, number));
}

export function readSplitRatio(storage) {
  try {
    const stored = storage.getItem(SPLIT_RATIO_KEY);
    return stored === null ? DEFAULT_SPLIT_RATIO : clampSplitRatio(stored);
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

export function writeSplitRatio(storage, ratio) {
  const normalized = clampSplitRatio(ratio);
  storage.setItem(SPLIT_RATIO_KEY, String(normalized));
  return normalized;
}

export function desktopPaneSizes({
  workspaceWidth,
  ratio,
  horizontalPadding = 16,
  sidebarWidth = 240,
  splitterWidth = 8,
  totalGapWidth = 24,
  editorMinWidth = 420,
  machineMinWidth = 340,
}) {
  const available = Math.max(0, workspaceWidth - horizontalPadding - sidebarWidth - splitterWidth - totalGapWidth);
  if (available < editorMinWidth + machineMinWidth) {
    return { available, editorWidth: editorMinWidth, machineWidth: Math.max(0, available - editorMinWidth) };
  }
  const editorWidth = Math.min(available - machineMinWidth, Math.max(editorMinWidth, available * clampSplitRatio(ratio)));
  return { available, editorWidth, machineWidth: available - editorWidth };
}

export function containedContentSize(intrinsicWidth, intrinsicHeight, availableWidth, availableHeight) {
  const sourceWidth = Math.max(1, Number(intrinsicWidth) || 1);
  const sourceHeight = Math.max(1, Number(intrinsicHeight) || 1);
  const scale = Math.max(0, Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight));
  return { width: sourceWidth * scale, height: sourceHeight * scale, scale };
}

export function mobileEditorHeight(ratio, minHeight = 160, maxHeight = 280) {
  const progress = (clampSplitRatio(ratio) - MIN_SPLIT_RATIO) / (MAX_SPLIT_RATIO - MIN_SPLIT_RATIO);
  return minHeight + (maxHeight - minHeight) * progress;
}
