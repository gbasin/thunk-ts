import * as Diff from "diff";

// Type augmentation for diffChars which exists but isn't in @types/diff
declare module "diff" {
  export function diffChars(
    oldStr: string,
    newStr: string,
  ): Array<{ value: string; added?: boolean; removed?: boolean }>;
}

export type CharChangeType = "add" | "remove" | "context";

export interface CharChange {
  type: CharChangeType;
  value: string;
}

export interface LineChange {
  type: "add" | "remove" | "context" | "modify";
  value: string;
  chars?: CharChange[];
}

export function buildLineDiff(oldText: string, newText: string): LineChange[] {
  const changes = Diff.diffLines(oldText, newText);
  const lines: LineChange[] = [];
  let i = 0;

  while (i < changes.length) {
    const change = changes[i];

    if (change.removed && changes[i + 1]?.added) {
      const removed = change.value;
      const added = changes[i + 1]?.value ?? "";
      const chars: CharChange[] = Diff.diffChars(removed, added).map((charChange) => {
        const type: CharChangeType = charChange.added
          ? "add"
          : charChange.removed
            ? "remove"
            : "context";
        return { type, value: charChange.value };
      });
      lines.push({ type: "modify", value: added, chars });
      i += 2;
      continue;
    }

    if (change.added) {
      lines.push({ type: "add", value: change.value });
    } else if (change.removed) {
      lines.push({ type: "remove", value: change.value });
    } else {
      lines.push({ type: "context", value: change.value });
    }

    i += 1;
  }

  return lines;
}
