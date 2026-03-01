/**
 * Lightweight marker types compatible with monaco.editor.IMarkerData.
 * Extracted to avoid importing the full Monaco editor in non-editor contexts (e.g. MCP mode).
 */

export enum MarkerSeverity {
  Hint = 1,
  Info = 2,
  Warning = 4,
  Error = 8,
}

export interface MarkerData {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: MarkerSeverity;
}
