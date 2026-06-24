import { useMemo, useState } from "react";
import { api } from "../api";
import { useWorkspace } from "../store";
import type { Doc } from "../types";

interface Slot { slideIdx: number; shapeIdx: number; paraIdx: number; text: string; kind: "ph" | "sp"; phType?: string }
interface ImgSlot { slideIdx: number; imageIdx: number; type: "pic" | "ph"; label: string; cx?: number; cy?: number; fillable: boolean }
interface Meta { slideCount: number; slots: Slot[]; images?: ImgSlot[]; warnings: string[] }
interface Row { value: string; checked: boolean }
interface ImgPick { dataBase64: string; ext: string; preview: string }

/** 上传 .pptx 模板「就地改图文」编辑器（方案① MVP）：逐槽确认 + AI 按来源建议 + 导出保真 pptx。
 *  只改文本、保留母版/版式/配色；表格/图表/SmartArt 列入告警、不就地改。 */
export function TemplateEditor({ doc }: { doc: Doc }) {
  const ws = useWorkspace();
  const meta = useMemo<Meta | null>(() => {
    try { const m = JSON.parse(doc.template_meta || "{}"); return Array.isArray(m.slots) ? m : null; } catch { return null; }
  }, [doc.template_meta]);

  const [rows, setRows] = useState<Row[]>(() => (meta?.slots ?? []).map((s) => ({ value: s.text, checked: false })));
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState<"" | "propose" | "export">("");
  const [note, setNote] = useState<string>("");
  const [imgPicks, setImgPicks] = useState<Record<string, ImgPick>>({}); // key=slideIdx:imageIdx → 选定图片
  const [imgPrompts, setImgPrompts] = useState<Record<string, string>>({});
  const [imgBusy, setImgBusy] = useState<string>(""); // 正在生成的 key

  const sourceDocs = ws.documents.filter((d) => d.kind === "source");
  if (!meta) return <div className="p-6 text-[13px] text-ink-3">无法解析该模板的槽位信息（template_meta 缺失或损坏）。请重新上传 .pptx。</div>;

  function setRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  async function aiPropose() {
    setBusy("propose"); setNote("");
    try {
      const { suggestions } = await api.proposeTemplateEdits(doc.id, { sourceDocIds: [...sources], brief: brief.trim() || undefined });
      if (!suggestions.length) { setNote("AI 未给出可替换建议（可能来源不足或都属固定文案）。可手动编辑。"); return; }
      setRows((rs) => rs.map((r, i) => {
        const s = suggestions.find((x) => x.idx === i);
        return s ? { value: s.suggestion, checked: true } : r;
      }));
      setNote(`AI 给出 ${suggestions.length} 处建议（已勾选，可逐条改/取消）。`);
    } catch (e) { setNote("AI 建议失败：" + ((e as Error)?.message ?? e)); }
    finally { setBusy(""); }
  }

  const imgKey = (s: ImgSlot) => `${s.slideIdx}:${s.imageIdx}`;

  async function genImage(s: ImgSlot) {
    const key = imgKey(s);
    const prompt = (imgPrompts[key] || "").trim();
    if (!prompt) { setNote("先填配图描述，再点生成。"); return; }
    setImgBusy(key); setNote("");
    try {
      const r = await api.generateTemplateImage(doc.id, prompt, (s.cx && s.cy && s.cy > s.cx) ? "1152x2048" : "2048x1152");
      setImgPicks((m) => ({ ...m, [key]: { dataBase64: r.dataBase64, ext: r.ext, preview: r.assetUrl } }));
      setNote("配图已生成（已选中，导出时嵌入）。");
    } catch (e) { setNote("配图生成失败：" + ((e as Error)?.message ?? e)); }
    finally { setImgBusy(""); }
  }

  function onUploadImage(s: ImgSlot, file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      const base64 = url.replace(/^data:[^,]*,/, "");
      const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
      setImgPicks((m) => ({ ...m, [imgKey(s)]: { dataBase64: base64, ext, preview: url } }));
    };
    reader.readAsDataURL(file);
  }

  async function exportPptx() {
    const edits = (meta!.slots).map((s, i) => ({ s, i }))
      .filter(({ i }) => rows[i].checked && rows[i].value.trim() && rows[i].value !== meta!.slots[i].text)
      .map(({ s, i }) => ({ slideIdx: s.slideIdx, shapeIdx: s.shapeIdx, paraIdx: s.paraIdx, newText: rows[i].value }));
    const imageEdits = Object.entries(imgPicks).map(([key, v]) => {
      const [slideIdx, imageIdx] = key.split(":").map(Number);
      return { slideIdx, imageIdx, dataBase64: v.dataBase64, ext: v.ext };
    });
    if (!edits.length && !imageEdits.length) { setNote("没有可导出的改动——勾选并改好文字槽、或为图片位选/生成配图，再导出。"); return; }
    setBusy("export"); setNote("");
    try {
      const blob = await api.templateExport(doc.id, edits, imageEdits);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = doc.title.replace(/\.pptx$/i, "").replace(/[\\/:*?"<>|]/g, "_") + "-已编辑.pptx";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setNote(`已导出：替换文字 ${edits.length} 处、换/填图 ${imageEdits.length} 处，其余保留原样。母版/版式/配色未改。`);
    } catch (e) { setNote("导出失败：" + ((e as Error)?.message ?? e)); }
    finally { setBusy(""); }
  }

  // 按页分组
  const byPage = new Map<number, number[]>();
  meta.slots.forEach((s, i) => { const a = byPage.get(s.slideIdx) ?? []; a.push(i); byPage.set(s.slideIdx, a); });
  const checkedCount = rows.filter((r, i) => r.checked && r.value !== meta.slots[i].text && r.value.trim()).length;

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <div className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-[12.5px] text-ink-2">
        🪄 模板就地改图文：勾选要替换的文字槽、改好文案后「导出已编辑 .pptx」。只换文本，<b>母版/版式/配色原样保留</b>；本迭代不换图。
      </div>

      {meta.warnings.length > 0 && (
        <div className="rounded-lg border border-line bg-sel/60 px-3 py-2 text-[12px] text-ink-2">
          ⚠️ 保真边界（以下结构本迭代保留原样、不就地改）：
          <ul className="ml-4 mt-1 list-disc">{meta.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {/* AI 按来源建议 */}
      <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">让 AI 按来源产替换文案（建议，仍需你逐槽确认）</div>
        {sourceDocs.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {sourceDocs.map((d) => {
              const on = sources.has(d.id);
              return (
                <button key={d.id}
                  onClick={() => setSources((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}
                  className={`rounded-full border px-2 py-0.5 text-[11.5px] ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-3 hover:bg-sel"}`}
                  title={d.title}>
                  {on ? "✓ " : "📎 "}{d.title.length > 16 ? d.title.slice(0, 16) + "…" : d.title}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mb-2 text-[11.5px] text-ink-3">还没有「来源」文档。可先在文档面板「📎 上传来源」，AI 会据此接地改写；也可只填下面的目标，仅做语义润色（不编造数字）。</div>
        )}
        <div className="flex gap-2">
          <input value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="目标/语气（可选）：如『改成面向银行客户的售前版、口吻稳重』"
            className="min-w-0 flex-1 rounded-lg border border-line bg-sel px-3 py-1.5 text-[12px] outline-none focus:border-accent/50" />
          <button onClick={aiPropose} disabled={busy !== ""}
            className="shrink-0 rounded-lg border border-accent/50 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
            {busy === "propose" ? "生成中…" : "✨ AI 按来源建议"}
          </button>
        </div>
      </div>

      {note && <div className="rounded-lg border border-line bg-sel/50 px-3 py-1.5 text-[12px] text-ink-2">{note}</div>}

      {/* 槽位清单（按页） */}
      <div className="flex flex-col gap-3">
        {[...byPage.keys()].sort((a, b) => a - b).map((page) => (
          <div key={page} className="rounded-lg border border-line">
            <div className="border-b border-line bg-sel/40 px-3 py-1.5 text-[12px] font-medium text-ink-2">第 {page + 1} 页</div>
            <div className="flex flex-col divide-y divide-line">
              {byPage.get(page)!.map((i) => {
                const s = meta.slots[i]; const r = rows[i];
                const changed = r.value !== s.text && r.value.trim() !== "";
                return (
                  <div key={i} className="flex gap-2 px-3 py-2">
                    <input type="checkbox" checked={r.checked} onChange={(e) => setRow(i, { checked: e.target.checked })}
                      className="mt-1 shrink-0" title="勾选 = 用下方文案替换此槽" />
                    <div className="min-w-0 flex-1">
                      {s.text ? (
                        <div className="mb-1 truncate text-[11px] text-ink-3" title={s.text}>原文：{s.text}</div>
                      ) : (
                        <div className="mb-1 text-[11px] text-accent/80">空占位（{s.phType || "内容"}）· 待填入</div>
                      )}
                      <textarea value={r.value} onChange={(e) => setRow(i, { value: e.target.value })}
                        placeholder={s.text ? "" : `按「${s.phType || "内容"}」填写…`}
                        rows={Math.min(4, Math.max(1, Math.ceil((r.value.length || 12) / 38)))}
                        className={`w-full resize-y rounded border px-2 py-1 text-[12.5px] outline-none ${changed ? "border-accent/60 bg-accent-soft/40" : "border-line bg-sel/40"} focus:border-accent/60`} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 配图（替换已有图 / 填入空图片占位） */}
      {(meta.images?.filter((s) => s.fillable).length ?? 0) > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-medium text-ink-2">配图（替换已有图 / 填入空图片占位 · 选填，生成或上传后随导出嵌入）</div>
          {meta.images!.filter((s) => s.fillable).map((s) => {
            const key = `${s.slideIdx}:${s.imageIdx}`;
            const pick = imgPicks[key];
            return (
              <div key={key} className="rounded-lg border border-line p-2.5">
                <div className="mb-1.5 flex items-center gap-2 text-[12px] text-ink-2">
                  <span className="rounded bg-sel px-1.5 py-px text-[11px]">第 {s.slideIdx + 1} 页</span>
                  <span>{s.type === "pic" ? "替换图片" : "填入空图片占位"}</span>
                  {pick && <span className="text-accent">✓ 已选（导出时嵌入）</span>}
                </div>
                <div className="flex items-start gap-2">
                  {pick && <img src={pick.preview} alt="" className="h-12 w-20 shrink-0 rounded border border-line object-cover" />}
                  <input value={imgPrompts[key] || ""} onChange={(e) => setImgPrompts((m) => ({ ...m, [key]: e.target.value }))}
                    placeholder="配图描述（如：明亮温暖的连锁餐厅门店、写实摄影）"
                    className="min-w-0 flex-1 rounded-lg border border-line bg-sel px-3 py-1.5 text-[12px] outline-none focus:border-accent/50" />
                  <button onClick={() => genImage(s)} disabled={imgBusy !== ""}
                    className="shrink-0 rounded-lg border border-accent/50 px-2.5 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
                    {imgBusy === key ? "生成中…" : "✨ 生成"}
                  </button>
                  <label className="shrink-0 cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-2 hover:bg-sel">
                    📁 上传<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) onUploadImage(s, f); }} />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 导出 */}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-panel py-2">
        <span className="text-[12px] text-ink-3">已勾选改动 {checkedCount} 处 · 共 {meta.slots.length} 槽 · {meta.slideCount} 页</span>
        <button onClick={exportPptx} disabled={busy !== ""}
          className="ml-auto rounded-lg border border-accent/50 px-3 py-1.5 text-[12px] font-medium text-accent hover:bg-accent-soft disabled:opacity-50">
          {busy === "export" ? "导出中…" : "⬇ 导出已编辑 .pptx"}
        </button>
      </div>
    </div>
  );
}
