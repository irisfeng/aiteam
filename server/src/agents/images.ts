import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import { getImageProvider } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 生成图资产目录（与 sqlite 同级），由 index.ts 以 /assets 静态托管；跟随 AITEAM_DATA_DIR 隔离 */
export const assetsDir = join(process.env.AITEAM_DATA_DIR || join(__dirname, "..", "..", "data"), "assets");
mkdirSync(assetsDir, { recursive: true });

/** 火山方舟 Seedream 默认端点（OpenAI images/generations 协议） */
export const DEFAULT_IMAGE_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const IMAGE_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;
const IMAGE_SIZES = ["2K", "2048x1152", "1152x2048", "2048x2048"] as const;

export function imageGenerationUrl(baseUrl: string): string {
  const base = (baseUrl || DEFAULT_IMAGE_BASE_URL).trim().replace(/\/+$/, "");
  return /\/images\/generations$/i.test(base) ? base : `${base}/images/generations`;
}

export function imageRequestPayload(model: string, prompt: string, size: string) {
  return {
    model,
    prompt,
    size,
    sequential_image_generation: "disabled",
    stream: false,
    response_format: "url",
    watermark: false,
  };
}

function imageSize(value: unknown): string {
  return IMAGE_SIZES.includes(value as (typeof IMAGE_SIZES)[number]) ? String(value) : "2048x1152";
}

function imageExtension(contentType: string): string {
  if (/image\/jpe?g/i.test(contentType)) return "jpg";
  if (/image\/webp/i.test(contentType)) return "webp";
  return "png";
}

type GeneratedImageBytes = { bytes: Buffer; ext: string; reportedSize: string } | { error: string };

async function decodeGeneratedImage(data: any): Promise<GeneratedImageBytes> {
  const item = data?.data?.[0];
  if (typeof item?.b64_json === "string" && item.b64_json) {
    const bytes = Buffer.from(item.b64_json, "base64");
    if (bytes.length === 0 || bytes.length > IMAGE_DOWNLOAD_LIMIT_BYTES) {
      return { error: "图像响应为空或超过 20MB 安全上限" };
    }
    return { bytes, ext: "png", reportedSize: String(item.size ?? "") };
  }

  if (typeof item?.url !== "string" || !item.url) return { error: "响应中没有图片 URL 或 base64 数据" };
  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return { error: "图像响应包含无效下载 URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "图像下载 URL 协议不受支持" };

  const downloaded = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!downloaded.ok) return { error: `图片下载失败（HTTP ${downloaded.status}）` };
  const contentType = downloaded.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    return { error: `图片下载响应类型异常（${contentType.slice(0, 80)}）` };
  }
  const declaredLength = Number(downloaded.headers.get("content-length") ?? 0);
  if (declaredLength > IMAGE_DOWNLOAD_LIMIT_BYTES) return { error: "图片下载超过 20MB 安全上限" };
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  if (bytes.length === 0 || bytes.length > IMAGE_DOWNLOAD_LIMIT_BYTES) {
    return { error: "图片下载为空或超过 20MB 安全上限" };
  }
  return { bytes, ext: imageExtension(contentType), reportedSize: String(item.size ?? "") };
}

async function requestGeneratedImage(prompt: string, requestedSize: unknown): Promise<GeneratedImageBytes> {
  const p = getImageProvider();
  if (!p.api_key || !p.model) return { error: "未配置图像生成供应商（设置 → 模型供应商 → 图像生成）" };
  const size = imageSize(requestedSize);
  const res = await fetch(imageGenerationUrl(p.base_url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.api_key}` },
    body: JSON.stringify(imageRequestPayload(p.model, prompt, size)),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: `图像生成失败（HTTP ${res.status}）：${body.slice(0, 300)}` };
  }
  return decodeGeneratedImage(await res.json());
}

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
        enum: [...IMAGE_SIZES],
        description: "尺寸：2048x1152=横幅（封面/PPT 配图，性价比默认）；1152x2048=竖幅；2048x2048=方形；2K=模型智能比例",
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
  const size = imageSize(input?.size);
  try {
    const generated = await requestGeneratedImage(prompt, size);
    if ("error" in generated) return `${generated.error}。请检查 Base URL、模型 ID 与账户额度。`;
    const file = `${nanoid(12)}.${generated.ext}`;
    writeFileSync(join(assetsDir, file), generated.bytes);
    return [
      `图片已生成并保存（${generated.reportedSize || size}，单图）。把下面这行 Markdown 原样放进交付物正文中需要配图的位置：`,
      ``,
      `![${prompt.slice(0, 40)}](/aiteam/assets/${file})`,
    ].join("\n");
  } catch (e) {
    return `图像生成异常：${String((e as Error)?.message ?? e).slice(0, 200)}。请检查网络、Base URL 与账户额度。`;
  }
}

/**
 * 生成图并返回 base64 字节（供「模板就地改图文」把生成图嵌入 .pptx，而非返回 Markdown）。
 * 同样落盘一份到 /assets 便于预览/复用。失败返回 { error }。
 */
export async function generateImageBytes(prompt: string, size?: string): Promise<{ dataBase64: string; ext: string; assetUrl: string } | { error: string }> {
  const p = getImageProvider();
  if (!p.api_key || !p.model) return { error: "未配置图像生成供应商（设置 → 模型供应商 → 图像生成）" };
  const pr = String(prompt ?? "").trim();
  if (!pr) return { error: "prompt 不能为空" };
  try {
    const generated = await requestGeneratedImage(pr, size);
    if ("error" in generated) return generated;
    const file = `${nanoid(12)}.${generated.ext}`;
    writeFileSync(join(assetsDir, file), generated.bytes);
    return { dataBase64: generated.bytes.toString("base64"), ext: generated.ext, assetUrl: `/aiteam/assets/${file}` };
  } catch (e) {
    return { error: `图像生成异常：${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }
}
