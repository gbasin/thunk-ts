/**
 * ProseMirror schema for the plan editor
 *
 * Node types:
 * - paragraph: regular editable text
 * - code_block: editable code with word-wrap
 * - diagram: non-editable ASCII diagram with horizontal scroll
 */

import { Schema, NodeSpec } from "prosemirror-model";
import type { Node as ProseMirrorNode } from "prosemirror-model";

// Box-drawing and arrow characters that indicate an ASCII diagram
const DIAGRAM_CHARS = /[─│┌┐└┘├┤┬┴┼╭╮╰╯║═╔╗╚╝╠╣╦╩╬▶◀▲▼→←↑↓┃┏┓┗┛┣┫┳┻╋]/;

/**
 * Check if a code block contains ASCII diagram characters
 */
export function isDiagram(content: string): boolean {
  return DIAGRAM_CHARS.test(content);
}

// GFM pipe table regex - matches header row, separator row, and data rows
// Separator row contains only |, -, :, and whitespace
const TABLE_REGEX = /^\|.+\|\s*\n\|[\s:|-]+\|\s*\n(\|.+\|\s*\n?)+$/;

/**
 * Check if text is a GFM pipe table
 */
export function isTable(content: string): boolean {
  return TABLE_REGEX.test(content.trim());
}

/**
 * Parse a GFM pipe table into headers and rows
 */
export function parseGFMTable(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.trim().split("\n");
  const headers = lines[0]
    .split("|")
    .slice(1, -1)
    .map((s) => s.trim());
  // Skip separator line (lines[1])
  const rows = lines.slice(2).map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim()),
  );
  return { headers, rows };
}

/**
 * Serialize headers and rows back to GFM pipe table format
 */
export function serializeGFMTable(headers: string[], rows: string[][]): string {
  const headerLine = "| " + headers.join(" | ") + " |";
  const separator = "| " + headers.map(() => "---").join(" | ") + " |";
  const dataLines = rows.map((row) => "| " + row.join(" | ") + " |");
  return [headerLine, separator, ...dataLines].join("\n");
}

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: "block+",
  },

  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p", preserveWhitespace: "full" as const }],
    toDOM() {
      return ["p", 0];
    },
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM() {
      return ["br"];
    },
  },

  code_block: {
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    attrs: {
      language: { default: "" },
    },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full" as const,
        getAttrs(node) {
          const el = node as HTMLElement;
          return { language: el.getAttribute("data-language") || "" };
        },
      },
    ],
    toDOM(node) {
      return [
        "pre",
        {
          class: "code-block",
          "data-language": node.attrs.language || "",
        },
        ["code", 0],
      ];
    },
  },

  diagram: {
    content: "text*",
    group: "block",
    code: true,
    defining: true,
    atom: true, // Treat as a single unit for selection
    parseDOM: [
      {
        tag: "pre.diagram-block",
        preserveWhitespace: "full" as const,
      },
    ],
    toDOM() {
      return ["pre", { class: "diagram-block" }, ["code", 0]];
    },
  },

  table: {
    group: "block",
    attrs: {
      headers: { default: [] as string[] },
      rows: { default: [] as string[][] },
    },
    atom: true, // Single unit for selection
    toDOM() {
      return ["div", { class: "table-wrapper" }, 0];
    },
  },

  text: {
    group: "inline",
  },
};

export const schema = new Schema({ nodes });

/**
 * Parse markdown text into a ProseMirror document
 */
export function parseMarkdown(text: string): ReturnType<typeof schema.node> {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const buildInlineContent = (value: string) => {
    if (!value) {
      return null;
    }
    const parts = value.split("\n");
    const nodes: ProseMirrorNode[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part) {
        nodes.push(schema.text(part));
      }
      if (i < parts.length - 1) {
        nodes.push(schema.nodes.hard_break.create());
      }
    }
    return nodes.length > 0 ? nodes : null;
  };
  const blocks: Array<{
    type: "paragraph" | "code_block" | "diagram" | "table";
    content: string;
    language?: string;
    headers?: string[];
    rows?: string[][];
  }> = [];

  // Split by code blocks
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(normalized)) !== null) {
    // Text before this code block
    const before = normalized.slice(lastIndex, match.index);
    if (before.trim()) {
      // Split into paragraphs
      const paragraphs = before.split(/\n\n+/);
      for (const p of paragraphs) {
        if (p.trim()) {
          if (isTable(p.trim())) {
            const { headers, rows } = parseGFMTable(p.trim());
            blocks.push({ type: "table", content: p.trim(), headers, rows });
          } else {
            blocks.push({ type: "paragraph", content: p.trim() });
          }
        }
      }
    }

    const language = match[1];
    // Trim trailing newline that appears before closing ```
    const content = match[2].replace(/\n$/, "");

    // Check if it's a diagram
    if (isDiagram(content)) {
      blocks.push({ type: "diagram", content });
    } else {
      blocks.push({ type: "code_block", content, language });
    }

    lastIndex = match.index + match[0].length;
  }

  // Text after last code block
  const after = normalized.slice(lastIndex);
  if (after.trim()) {
    const paragraphs = after.split(/\n\n+/);
    for (const p of paragraphs) {
      if (p.trim()) {
        if (isTable(p.trim())) {
          const { headers, rows } = parseGFMTable(p.trim());
          blocks.push({ type: "table", content: p.trim(), headers, rows });
        } else {
          blocks.push({ type: "paragraph", content: p.trim() });
        }
      }
    }
  }

  // Handle empty document
  if (blocks.length === 0) {
    blocks.push({ type: "paragraph", content: "" });
  }

  // Build ProseMirror nodes
  const docNodes = blocks.map((block) => {
    if (block.type === "paragraph") {
      return schema.nodes.paragraph.create(null, buildInlineContent(block.content));
    } else if (block.type === "diagram") {
      return schema.nodes.diagram.create(null, block.content ? schema.text(block.content) : null);
    } else if (block.type === "table") {
      return schema.nodes.table.create({
        headers: block.headers || [],
        rows: block.rows || [],
      });
    } else {
      return schema.nodes.code_block.create(
        { language: block.language || "" },
        block.content ? schema.text(block.content) : null,
      );
    }
  });

  return schema.node("doc", null, docNodes);
}

/**
 * Serialize a ProseMirror document back to markdown
 */
export function serializeMarkdown(doc: ReturnType<typeof schema.node>): string {
  const parts: string[] = [];
  const serializeInline = (node: ReturnType<typeof schema.node>): string => {
    let result = "";
    node.forEach((child) => {
      if (child.isText) {
        result += child.text;
      } else if (child.type.name === "hard_break") {
        result += "\n";
      }
    });
    return result;
  };

  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      parts.push(serializeInline(node));
      parts.push(""); // Empty line after paragraph
    } else if (node.type.name === "code_block") {
      const lang = node.attrs.language || "";
      parts.push("```" + lang);
      parts.push(node.textContent);
      parts.push("```");
      parts.push(""); // Empty line after code block
    } else if (node.type.name === "diagram") {
      parts.push("```");
      parts.push(node.textContent);
      parts.push("```");
      parts.push(""); // Empty line after diagram
    } else if (node.type.name === "table") {
      const headers = node.attrs.headers as string[];
      const rows = node.attrs.rows as string[][];
      parts.push(serializeGFMTable(headers, rows));
      parts.push(""); // Empty line after table
    }
  });

  // Remove trailing empty lines and join
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }

  return parts.join("\n");
}
