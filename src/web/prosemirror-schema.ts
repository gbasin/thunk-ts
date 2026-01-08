/**
 * ProseMirror schema for the plan editor
 *
 * Node types:
 * - paragraph: regular editable text
 * - code_block: editable code with word-wrap
 * - diagram: non-editable ASCII diagram with horizontal scroll
 */

import { Schema, NodeSpec, MarkSpec } from "prosemirror-model";
import type { Mark, Node as ProseMirrorNode } from "prosemirror-model";

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

  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: {
      level: { default: 1 },
    },
    parseDOM: [
      { tag: "h1", getAttrs: () => ({ level: 1 }) },
      { tag: "h2", getAttrs: () => ({ level: 2 }) },
      { tag: "h3", getAttrs: () => ({ level: 3 }) },
      { tag: "h4", getAttrs: () => ({ level: 4 }) },
      { tag: "h5", getAttrs: () => ({ level: 5 }) },
      { tag: "h6", getAttrs: () => ({ level: 6 }) },
    ],
    toDOM(node) {
      const level = Math.max(1, Math.min(6, node.attrs.level || 1));
      return ["h" + level, 0];
    },
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

  bullet_list: {
    group: "block",
    content: "list_item+",
    parseDOM: [{ tag: "ul" }],
    toDOM() {
      return ["ul", 0];
    },
  },

  ordered_list: {
    group: "block",
    content: "list_item+",
    attrs: {
      order: { default: 1 },
    },
    parseDOM: [
      {
        tag: "ol",
        getAttrs(node) {
          const el = node as HTMLOListElement;
          const start = el.getAttribute("start");
          return { order: start ? Number(start) : 1 };
        },
      },
    ],
    toDOM(node) {
      const order = node.attrs.order as number;
      const attrs = order && order !== 1 ? { start: String(order) } : {};
      return ["ol", attrs, 0];
    },
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM() {
      return ["li", 0];
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

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM() {
      return ["strong", 0];
    },
  },
  em: {
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM() {
      return ["em", 0];
    },
  },
  strike: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }],
    toDOM() {
      return ["s", 0];
    },
  },
};

export const schema = new Schema({ nodes, marks });

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
        nodes.push(...parseInlineWithMarks(part));
      }
      if (i < parts.length - 1) {
        nodes.push(schema.nodes.hard_break.create());
      }
    }
    return nodes.length > 0 ? nodes : null;
  };
  const parseHeading = (value: string) => {
    const match = value.match(/^(#{1,6})\s+(.*)$/);
    if (!match) return null;
    return { level: match[1].length, content: match[2] ?? "" };
  };
  const parseList = (value: string) => {
    const lines = value.split("\n");
    if (lines.some((line) => line.trim() === "")) {
      return null;
    }

    const bulletItems: string[] = [];
    const orderedItems: Array<{ order: number; content: string }> = [];

    let allBullet = true;
    let allOrdered = true;

    for (const line of lines) {
      const bulletMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      const orderedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);

      if (bulletMatch) {
        bulletItems.push(bulletMatch[1]);
      } else {
        allBullet = false;
      }

      if (orderedMatch) {
        orderedItems.push({ order: Number(orderedMatch[1]), content: orderedMatch[2] });
      } else {
        allOrdered = false;
      }
    }

    if (allOrdered && orderedItems.length > 0) {
      return {
        type: "ordered_list" as const,
        order: orderedItems[0].order || 1,
        items: orderedItems.map((item) => item.content),
      };
    }

    if (allBullet && bulletItems.length > 0) {
      return { type: "bullet_list" as const, items: bulletItems };
    }

    return null;
  };
  const blocks: Array<{
    type:
      | "paragraph"
      | "code_block"
      | "diagram"
      | "table"
      | "heading"
      | "bullet_list"
      | "ordered_list";
    content: string;
    language?: string;
    headers?: string[];
    rows?: string[][];
    level?: number;
    items?: string[];
    order?: number;
  }> = [];

  const pushTextBlocks = (chunk: string) => {
    const paragraphs = chunk.split(/\n\n+/);
    for (const p of paragraphs) {
      if (!p.trim()) {
        continue;
      }

      const trimmed = p.trim();
      if (isTable(trimmed)) {
        const { headers, rows } = parseGFMTable(trimmed);
        blocks.push({ type: "table", content: trimmed, headers, rows });
        continue;
      }

      const list = parseList(trimmed);
      if (list) {
        blocks.push({
          type: list.type,
          content: trimmed,
          items: list.items,
          order: list.type === "ordered_list" ? list.order : undefined,
        });
        continue;
      }

      const heading = parseHeading(trimmed);
      if (heading) {
        blocks.push({
          type: "heading",
          content: heading.content,
          level: heading.level,
        });
        continue;
      }

      blocks.push({ type: "paragraph", content: trimmed });
    }
  };

  // Split by code blocks
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(normalized)) !== null) {
    // Text before this code block
    const before = normalized.slice(lastIndex, match.index);
    if (before.trim()) {
      pushTextBlocks(before);
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
    pushTextBlocks(after);
  }

  // Handle empty document
  if (blocks.length === 0) {
    blocks.push({ type: "paragraph", content: "" });
  }

  // Build ProseMirror nodes
  const docNodes = blocks.map((block) => {
    if (block.type === "paragraph") {
      return schema.nodes.paragraph.create(null, buildInlineContent(block.content));
    } else if (block.type === "heading") {
      const level = block.level ?? 1;
      return schema.nodes.heading.create({ level }, buildInlineContent(block.content));
    } else if (block.type === "bullet_list" || block.type === "ordered_list") {
      const items = block.items ?? [];
      const listItems = items.map((item) =>
        schema.nodes.list_item.create(
          null,
          schema.nodes.paragraph.create(null, buildInlineContent(item)),
        ),
      );
      if (block.type === "ordered_list") {
        return schema.nodes.ordered_list.create({ order: block.order ?? 1 }, listItems);
      }
      return schema.nodes.bullet_list.create(null, listItems);
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

function parseInlineWithMarks(text: string): ProseMirrorNode[] {
  const nodes: ProseMirrorNode[] = [];
  const delimiterMarks: Record<string, Mark> = {
    "**": schema.marks.strong.create(),
    "*": schema.marks.em.create(),
    "~~": schema.marks.strike.create(),
  };

  const isEscaped = (value: string, index: number) => {
    let backslashes = 0;
    for (let i = index - 1; i >= 0 && value[i] === "\\"; i--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  };

  const findClosing = (value: string, start: number, delimiter: string) => {
    for (let i = start; i < value.length; i++) {
      if (delimiter.length === 2) {
        if (value.startsWith(delimiter, i) && !isEscaped(value, i)) {
          return i;
        }
      } else if (value[i] === delimiter && !isEscaped(value, i)) {
        return i;
      }
    }
    return -1;
  };

  const appendText = (value: string, marks: Mark[]) => {
    if (!value) {
      return;
    }
    nodes.push(schema.text(value, marks));
  };

  const parseSegment = (value: string, marks: Mark[]) => {
    let cursor = 0;
    let buffer = "";

    while (cursor < value.length) {
      const char = value[cursor];
      if (char === "\\" && cursor + 1 < value.length) {
        buffer += value[cursor + 1];
        cursor += 2;
        continue;
      }

      let delimiter: "**" | "*" | "~~" | null = null;
      if (value.startsWith("**", cursor) && !isEscaped(value, cursor)) {
        delimiter = "**";
      } else if (value.startsWith("~~", cursor) && !isEscaped(value, cursor)) {
        delimiter = "~~";
      } else if (char === "*" && !isEscaped(value, cursor)) {
        delimiter = "*";
      }

      if (!delimiter) {
        buffer += char;
        cursor += 1;
        continue;
      }

      if (buffer) {
        appendText(buffer, marks);
        buffer = "";
      }

      const closeIndex = findClosing(value, cursor + delimiter.length, delimiter);
      if (closeIndex === -1 || closeIndex === cursor + delimiter.length) {
        buffer += delimiter;
        cursor += delimiter.length;
        continue;
      }

      const inner = value.slice(cursor + delimiter.length, closeIndex);
      const nextMarks = marks.concat(delimiterMarks[delimiter]);
      parseSegment(inner, nextMarks);

      cursor = closeIndex + delimiter.length;
    }

    if (buffer) {
      appendText(buffer, marks);
    }
  };

  parseSegment(text, []);
  return nodes;
}

/**
 * Serialize a ProseMirror document back to markdown
 */
export function serializeMarkdown(doc: ReturnType<typeof schema.node>): string {
  const parts: string[] = [];
  const serializeInline = (node: ReturnType<typeof schema.node>): string => {
    let result = "";
    const order = ["strike", "strong", "em"];
    let active: Mark[] = [];

    const markerFor = (mark: Mark) => {
      if (mark.type.name === "strong") return "**";
      if (mark.type.name === "em") return "*";
      return "~~";
    };

    const sortMarks = (marks: readonly Mark[]) =>
      marks
        .filter((mark) => order.includes(mark.type.name))
        .slice()
        .sort((a, b) => order.indexOf(a.type.name) - order.indexOf(b.type.name));

    const closeMarks = (marksToClose: Mark[]) => {
      for (let i = marksToClose.length - 1; i >= 0; i--) {
        result += markerFor(marksToClose[i]);
      }
    };

    const openMarks = (marksToOpen: Mark[]) => {
      for (const mark of marksToOpen) {
        result += markerFor(mark);
      }
    };

    node.forEach((child) => {
      if (child.isText) {
        const nextMarks = sortMarks(child.marks);
        const toClose = active.filter((mark) => !nextMarks.some((next) => next.type === mark.type));
        const toOpen = nextMarks.filter((mark) => !active.some((prev) => prev.type === mark.type));

        if (toClose.length > 0) {
          closeMarks(toClose);
        }
        if (toOpen.length > 0) {
          openMarks(toOpen);
        }

        active = nextMarks;
        result += child.text;
      } else if (child.type.name === "hard_break") {
        result += "\n";
      }
    });

    if (active.length > 0) {
      closeMarks(active);
    }

    return result;
  };

  doc.forEach((node) => {
    if (node.type.name === "heading") {
      const level = Math.max(1, Math.min(6, node.attrs.level || 1));
      parts.push("#".repeat(level) + " " + serializeInline(node));
      parts.push("");
    } else if (node.type.name === "paragraph") {
      parts.push(serializeInline(node));
      parts.push(""); // Empty line after paragraph
    } else if (node.type.name === "bullet_list") {
      node.forEach((item) => {
        const paragraph = item.firstChild;
        const line = paragraph ? serializeInline(paragraph) : "";
        parts.push(`- ${line}`);
      });
      parts.push("");
    } else if (node.type.name === "ordered_list") {
      let order = node.attrs.order || 1;
      node.forEach((item) => {
        const paragraph = item.firstChild;
        const line = paragraph ? serializeInline(paragraph) : "";
        parts.push(`${order}. ${line}`);
        order += 1;
      });
      parts.push("");
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
