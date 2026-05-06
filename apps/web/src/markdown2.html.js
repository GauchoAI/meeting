import DOMPurify from "dompurify";
import { marked } from "marked";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: getMermaidThemeVariables()
});

let renderId = 0;

export async function markdownToHtml(markdown) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: getMermaidThemeVariables()
  });
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

function getMermaidThemeVariables() {
  if (typeof window === "undefined") {
    return {
      primaryColor: "#1f2937",
      primaryTextColor: "#f8fafc",
      primaryBorderColor: "#84cc16",
      lineColor: "#94a3b8"
    };
  }
  const style = getComputedStyle(document.documentElement);
  const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--canvas", "#0b1020"),
    mainBkg: value("--panel2", "#1f2937"),
    primaryColor: value("--panel2", "#1f2937"),
    primaryTextColor: value("--ink", "#f8fafc"),
    primaryBorderColor: value("--accent", "#84cc16"),
    secondaryColor: value("--panel", "#111827"),
    secondaryTextColor: value("--ink", "#f8fafc"),
    secondaryBorderColor: value("--line", "#334155"),
    tertiaryColor: value("--code-bg", "#0f172a"),
    tertiaryTextColor: value("--ink", "#f8fafc"),
    tertiaryBorderColor: value("--line", "#334155"),
    nodeTextColor: value("--ink", "#f8fafc"),
    textColor: value("--ink", "#f8fafc"),
    lineColor: value("--muted", "#94a3b8"),
    edgeLabelBackground: value("--canvas", "#0b1020"),
    clusterBkg: value("--code-bg", "#0f172a"),
    clusterBorder: value("--line", "#334155"),
    fontFamily: value("--font-family", "Inter, ui-sans-serif, system-ui")
  };
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

