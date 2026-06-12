import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { getImageProvider } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 生成图资产目录（与 sqlite 同级），由 index.ts 以 /assets 静态托管 */
export const assetsDir = join(__dirname, "..", "..", "data", "assets");
mkdirSync(assetsDir, { recursive: true });

/** 火山方舟 Seedream 默认端点（OpenAI images/generations 协议） */
export const DEFAULT_IMAGE_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export function imageGenAvailable(): boolean {
  const p = getImageProvider();
  return Boolean(p.api_key && p.model);
}

export const IMAGE_TOOL: Anthropic.Tool = {
  name: "generate_image",
  description:
    "用文生图模型（Seedream）生成一张配图，返回可直接嵌入文档的 Markdown 图片语法。" +
    "适用：报告封面/概念示意图/PPT 配图/品牌视觉。生成按张计费——一个任务通常 1-2 张点睛即可，" +
    "先想清楚画面再调用；数据图表请用 sheet 交付物（自带图表渲染），不要用文生图画图表。" +
    "prompt 用中文或英文描述画面主体、风格、构图、色调（如：扁平插画风、暖琥珀色调、简洁留白）。",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string", description: "画面描述：主体、风格、构图、色调；越具体效果越好" },
      size: {
        type: "string",
        enum: ["2048x1152", "1152x2048", "2048x2048"],
        description: "尺寸：2048x1152=横幅（封面/PPT 配图，默认）；1152x2048=竖幅；2048x2048=方形",
      },
    },
    required: ["prompt"],
  },
};

/**
 * 调用 Seedream（或任何 OpenAI images/generations 兼容端点）生成图片，
 * b64 回传后落盘到 /assets，返回给模型一段可直接粘贴进文档的 Markdown。
 */
export async function generateImage(input: any): Promise<string> {
  const p = getImageProvider();
  if (!p.api_key || !p.model) return "错误：未配置图像生成供应商（⚙ 设置 → 模型供应商 → 图像生成）。";
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) return "错误：prompt 不能为空。";
  const size = ["2048x1152", "1152x2048", "2048x2048"].includes(input?.size) ? input.size : "2048x1152";

  const res = await fetch(`${p.base_url || DEFAULT_IMAGE_BASE_URL}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.api_key}` },
    body: JSON.stringify({
      model: p.model,
      prompt,
      size,
      response_format: "b64_json",
      watermark: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `图像生成失败（HTTP ${res.status}）：${body.slice(0, 300)}。请检查图像供应商配置（model 是否为方舟控制台展示的接入点 ID）。`;
  }
  const data: any = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) {
    // 个别网关只支持 url 回传
    const url = data?.data?.[0]?.url;
    if (url) return `图片已生成（外链，约 24 小时有效）。嵌入文档：\n![${prompt.slice(0, 40)}](${url})`;
    return `图像生成失败：响应中没有图片数据（${JSON.stringify(data).slice(0, 200)}）`;
  }
  const file = `${nanoid(12)}.png`;
  writeFileSync(join(assetsDir, file), Buffer.from(b64, "base64"));
  return [
    `图片已生成并保存（${size}）。把下面这行 Markdown 原样放进交付物正文中需要配图的位置：`,
    ``,
    `![${prompt.slice(0, 40)}](/assets/${file})`,
  ].join("\n");
}
