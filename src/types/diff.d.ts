declare module "diff" {
  export type Change = { added?: boolean; removed?: boolean; value: string };

  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number },
  ): string;

  export function diffLines(oldStr: string, newStr: string): Change[];
}
