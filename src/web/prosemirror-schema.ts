/**
 * ProseMirror schema for the plan editor
 *
 * Node types:
 * - paragraph: regular editable text
 * - code_block: editable code with word-wrap
 * - diagram: non-editable ASCII diagram with horizontal scroll
 */

import { Schema, NodeSpec } from "prosemirror-model";

// Box-drawing and arrow characters that indicate an ASCII diagram
const DIAGRAM_CHARS = /[─│┌┐└┘├┤┬┴┼╭╮╰╯║═╔╗╚╝╠╣╦╩╬▶◀▲▼→←↑↓┃┏┓┗┛┣┫┳┻╋]/;

/**
 * Check if a code block contains ASCII diagram characters
 */
export function isDiagram(content: string): boolean {
  return DIAGRAM_CHARS.test(content);
}

const nodes: Record<string, NodeSpec> = {
  doc: {
    content: "block+",
  },

  paragraph: {
    content: "text*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM() {
      return ["p", 0];
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

  text: {
    group: "inline",
  },
};

export const schema = new Schema({ nodes });

/**
 * Parse markdown text into a ProseMirror document
 */
export function parseMarkdown(text: string): ReturnType<typeof schema.node> {
  const blocks: Array<{
    type: "paragraph" | "code_block" | "diagram";
    content: string;
    language?: string;
  }> = [];

  // Split by code blocks
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before this code block
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) {
      // Split into paragraphs
      const paragraphs = before.split(/\n\n+/);
      for (const p of paragraphs) {
        if (p.trim()) {
          blocks.push({ type: "paragraph", content: p.trim() });
        }
      }
    }

    const language = match[1];
    const content = match[2];

    // Check if it's a diagram
    if (isDiagram(content)) {
      blocks.push({ type: "diagram", content });
    } else {
      blocks.push({ type: "code_block", content, language });
    }

    lastIndex = match.index + match[0].length;
  }

  // Text after last code block
  const after = text.slice(lastIndex);
  if (after.trim()) {
    const paragraphs = after.split(/\n\n+/);
    for (const p of paragraphs) {
      if (p.trim()) {
        blocks.push({ type: "paragraph", content: p.trim() });
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
      return schema.nodes.paragraph.create(null, block.content ? schema.text(block.content) : null);
    } else if (block.type === "diagram") {
      return schema.nodes.diagram.create(null, block.content ? schema.text(block.content) : null);
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

  doc.forEach((node) => {
    if (node.type.name === "paragraph") {
      parts.push(node.textContent);
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
    }
  });

  // Remove trailing empty lines and join
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }

  return parts.join("\n");
}
