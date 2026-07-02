import type { Doc } from "../types";

// 交付物图标的单一来源：DocsView 与频道侧栏分处 lazy-load 边界两侧，各自维护会在新增 kind 时漏改。
export const DOC_KIND_ICON: Record<Doc["kind"], string> = {
  report: "📄",
  slides: "🖥️",
  sheet: "📊",
  html: "🌐",
  source: "📎",
  template: "🪄",
};
