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
    ADD_ATTR: ["target", "data-mermaid-index", "data-collapsed-default"],
    ADD_TAGS: ["button", "details", "summary"]
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
  return prepareLongConversationSections(html);
}

function prepareLongConversationSections(html) {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  renderNestedMarkdownCodeBlocks(doc, root);
  collapseLongConversationSections(doc, root);
  return root.innerHTML;
}

function renderNestedMarkdownCodeBlocks(doc, root) {
  const blocks = Array.from(root.querySelectorAll("details pre > code.language-markdown, details pre > code[class~='language-md']"));
  for (const code of blocks) {
    const source = code.textContent || "";
    if (source.trim().length < 200) continue;
    const rendered = doc.createElement("div");
    rendered.className = "md-rendered-nested-markdown";
    rendered.innerHTML = DOMPurify.sanitize(marked.parse(source, { async: false, breaks: true }), {
      ADD_ATTR: ["target", "data-collapsed-default"],
      ADD_TAGS: ["button", "details", "summary"]
    });
    code.closest("pre")?.replaceWith(rendered);
  }
}

function collapseLongConversationSections(doc, root) {
  const existingDetails = Array.from(root.querySelectorAll("details"));
  for (const details of existingDetails) {
    const title = details.querySelector("summary")?.textContent?.trim() || "";
    const bodyText = details.textContent?.trim() || "";
    if (!/\b(conversation|transcript|dialogue|conversaci[oó]n|transcripci[oó]n|di[aá]logo)\b/i.test(title)) continue;
    if (bodyText.length < 1200) continue;
    details.classList.add("md-collapsible-section", "md-conversation-section");
    details.setAttribute("data-collapsed-default", "true");
    details.removeAttribute("open");
  }

  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((heading) => !heading.closest("details"));
  for (const heading of headings) {
    const title = heading.textContent?.trim() || "";
    if (!/\b(conversation|transcript|dialogue|conversaci[oó]n|transcripci[oó]n|di[aá]logo)\b/i.test(title)) continue;
    const level = Number(heading.tagName.slice(1));
    const sectionNodes = [];
    let cursor = heading.nextSibling;
    while (cursor) {
      if (cursor.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(cursor.nodeName) && Number(cursor.nodeName.slice(1)) <= level) break;
      sectionNodes.push(cursor);
      cursor = cursor.nextSibling;
    }
    const sectionText = sectionNodes.map((node) => node.textContent || "").join(" ").trim();
    if (sectionText.length < 1200 && sectionNodes.length < 10) continue;
    const details = doc.createElement("details");
    details.className = "md-collapsible-section md-conversation-section";
    details.setAttribute("data-collapsed-default", "true");
    const summary = doc.createElement("summary");
    summary.textContent = `Mostrar / ocultar ${title}`;
    details.appendChild(summary);
    heading.after(details);
    for (const node of sectionNodes) details.appendChild(node);
  }
  return root.innerHTML;
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

