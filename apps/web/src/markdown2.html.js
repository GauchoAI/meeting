import DOMPurify from "dompurify";
import { marked } from "marked";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark"
});

let renderId = 0;

export async function markdownToHtml(markdown) {
  const id = ++renderId;
  const diagrams = [];
  const withDiagramPlaceholders = String(markdown || "").replace(/```mermaid\n([\s\S]*?)```/g, (_, source) => {
    const index = diagrams.push(source.trim()) - 1;
    return `<div class="mermaid-slot" data-mermaid-index="${index}"></div>`;
  });
  const unsafe = marked.parse(withDiagramPlaceholders, { async: false, breaks: true });
  let html = DOMPurify.sanitize(unsafe, {
    ADD_ATTR: ["target", "data-mermaid-index"],
    ADD_TAGS: ["button"]
  });
  for (let index = 0; index < diagrams.length; index += 1) {
    try {
      const rendered = await mermaid.render(`meeting-mermaid-${id}-${index}`, diagrams[index]);
      html = html.replace(`<div class="mermaid-slot" data-mermaid-index="${index}"></div>`, `<div class="diagram">${rendered.svg}</div>`);
    } catch (error) {
      html = html.replace(
        `<div class="mermaid-slot" data-mermaid-index="${index}"></div>`,
        `<pre class="diagram-error">${escapeHtml(diagrams[index])}\n\n${escapeHtml(error.message || String(error))}</pre>`
      );
    }
  }
  return html;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

