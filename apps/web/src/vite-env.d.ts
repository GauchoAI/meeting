/// <reference types="vite/client" />

declare module "./markdown2.html.js" {
  export function markdownToHtml(markdown: string): Promise<string>;
}
