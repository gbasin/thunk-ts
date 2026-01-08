/**
 * Tests for prosemirror-schema.ts
 */

import { describe, test, expect } from "bun:test";
import {
  isTable,
  parseGFMTable,
  serializeGFMTable,
  parseMarkdown,
  serializeMarkdown,
} from "../src/web/prosemirror-schema.js";

describe("GFM Table Detection", () => {
  test("detects simple table", () => {
    const table = `| A | B |
| --- | --- |
| 1 | 2 |`;
    expect(isTable(table)).toBe(true);
  });

  test("detects table with multiple rows", () => {
    const table = `| Name | Age | City |
| --- | --- | --- |
| Alice | 30 | NYC |
| Bob | 25 | LA |`;
    expect(isTable(table)).toBe(true);
  });

  test("rejects non-table text", () => {
    expect(isTable("Just some text")).toBe(false);
    expect(isTable("| partial |")).toBe(false);
    expect(isTable("| no | separator |")).toBe(false);
  });

  test("detects table with alignment markers", () => {
    const table = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;
    expect(isTable(table)).toBe(true);
  });
});

describe("GFM Table Parsing", () => {
  test("parses simple table", () => {
    const table = `| A | B |
| --- | --- |
| 1 | 2 |`;
    const result = parseGFMTable(table);
    expect(result.headers).toEqual(["A", "B"]);
    expect(result.rows).toEqual([["1", "2"]]);
  });

  test("parses table with multiple rows", () => {
    const table = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`;
    const result = parseGFMTable(table);
    expect(result.headers).toEqual(["Name", "Age"]);
    expect(result.rows).toEqual([
      ["Alice", "30"],
      ["Bob", "25"],
    ]);
  });

  test("trims cell content", () => {
    const table = `|  Name  |  Age  |
| --- | --- |
|  Alice  |  30  |`;
    const result = parseGFMTable(table);
    expect(result.headers).toEqual(["Name", "Age"]);
    expect(result.rows).toEqual([["Alice", "30"]]);
  });
});

describe("GFM Table Serialization", () => {
  test("serializes simple table", () => {
    const headers = ["A", "B"];
    const rows = [["1", "2"]];
    const result = serializeGFMTable(headers, rows);
    expect(result).toBe(`| A | B |
| --- | --- |
| 1 | 2 |`);
  });

  test("serializes table with multiple rows", () => {
    const headers = ["Name", "Age"];
    const rows = [
      ["Alice", "30"],
      ["Bob", "25"],
    ];
    const result = serializeGFMTable(headers, rows);
    expect(result).toBe(`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`);
  });
});

describe("Table Round-trip", () => {
  test("parse -> serialize preserves table structure", () => {
    const original = `| A | B |
| --- | --- |
| 1 | 2 |`;
    const { headers, rows } = parseGFMTable(original);
    const serialized = serializeGFMTable(headers, rows);
    expect(serialized).toBe(original);
  });
});

describe("Markdown with Tables", () => {
  test("parses markdown containing a table", () => {
    const markdown = `Some text

| A | B |
| --- | --- |
| 1 | 2 |

More text`;

    const doc = parseMarkdown(markdown);
    const nodes: string[] = [];
    doc.forEach((node) => nodes.push(node.type.name));
    expect(nodes).toContain("table");
  });

  test("serializes markdown containing a table", () => {
    const markdown = `Some text

| A | B |
| --- | --- |
| 1 | 2 |

More text`;

    const doc = parseMarkdown(markdown);
    const serialized = serializeMarkdown(doc);

    expect(serialized).toContain("| A | B |");
    expect(serialized).toContain("| --- | --- |");
    expect(serialized).toContain("| 1 | 2 |");
  });

  test("round-trip: parse -> serialize -> parse -> serialize", () => {
    const original = `Header paragraph

| Col1 | Col2 | Col3 |
| --- | --- | --- |
| a | b | c |
| d | e | f |

Footer paragraph`;

    const doc1 = parseMarkdown(original);
    const serialized1 = serializeMarkdown(doc1);
    const doc2 = parseMarkdown(serialized1);
    const serialized2 = serializeMarkdown(doc2);

    // After first round-trip, should be stable
    expect(serialized1).toBe(serialized2);
  });
});

describe("Markdown Blocks", () => {
  test("parses headings and lists", () => {
    const markdown = `# Title

## Section

- First
- Second

1. Alpha
2. Beta`;

    const doc = parseMarkdown(markdown);
    const nodes: string[] = [];
    doc.forEach((node) => nodes.push(node.type.name));

    expect(nodes).toContain("heading");
    expect(nodes).toContain("bullet_list");
    expect(nodes).toContain("ordered_list");
  });
});

describe("Markdown Marks", () => {
  test("round-trips bold, italic, and strike", () => {
    const markdown = `This is **bold**, *italic*, and ~~strike~~.`;

    const doc = parseMarkdown(markdown);
    const serialized = serializeMarkdown(doc);

    expect(serialized).toContain("**bold**");
    expect(serialized).toContain("*italic*");
    expect(serialized).toContain("~~strike~~");
  });

  test("round-trips nested marks consistently", () => {
    const markdown = `Mix **bold *italic*** and ~~strike **bold**~~.`;

    const doc1 = parseMarkdown(markdown);
    const serialized1 = serializeMarkdown(doc1);
    const doc2 = parseMarkdown(serialized1);
    const serialized2 = serializeMarkdown(doc2);

    expect(serialized1).toBe(serialized2);
  });
});
