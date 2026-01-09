/**
 * Shared type guards and type utilities
 */

/**
 * Type guard to check if a value is a non-array object (record/dictionary).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
