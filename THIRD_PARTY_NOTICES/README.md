# 第三方致谢与许可（Third-Party Notices）

AITeam 的部分**内置方法包技能**（`server/src/seed.ts` 的 `BUILTIN_SKILLS`）是对下列开源 skill 仓库的
**方法学蒸馏改写**——只提取方法论要点、用自有中文措辞重写，不复制原文连续段落、不照搬原 SKILL.md 结构。
在此按来源致谢并记录许可（MIT/Apache 要求保留版权声明，故集中存档于本目录）。

> 蒸馏判定：只取「怎么做」的方法学（方法学本身不受版权保护），措辞自写；每条技能 `body` 末尾标注来源。
> 凡需要执行的能力（文档解析、可编辑 PPTX、联网检索）一律走 MCP/原生工具（见 `server/src/registry.ts`），
> **不内置分发任何第三方二进制、CLI 或受限文本**。

## 来源与映射

| 来源仓库 | 许可 | 蒸馏进的内置技能 |
|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | MIT | 可验证规格法 / 假设-证伪调试法 / PR 审查法 / 设计前置头脑风暴法 / 实现计划法 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT (© Matt Pocock) | 并入 可验证规格法 / 假设-证伪调试法 |
| [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) | MIT | 文档结构化排版法 / 翻译三档法 / SVG 图表生成法 / 信息图·封面·配图生成法 |
| [zarazhangrui/frontend-slides](https://github.com/zarazhangrui/frontend-slides) | MIT (© 2025 Zara Zhang) | 演示设计与防溢出法 / 反 AI-slop 设计审美守则 |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | MIT (© 2026 Leonxlnx) | 反 AI-slop 设计审美守则 |
| [op7418/guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill) | 见仓库 | 演示设计与防溢出法（网页 deck 范式） |
| [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master) | MIT (© 2025-2026 Hugo He) | 「可编辑 PPTX 能力」capability 指向（不内置代码，走 MCP） |
| Vercel react-best-practices / [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | MIT / CC | 前端工程自查法 |
| gstack/Hermes bundled skills (document-generate / diagram / review) | Apache-2.0（仅采用 CC0 的 SKILL.md 方法要点，正文不直接内置） | Diataxis 文档生成法 / SVG 图表生成法 / PR 审查法 |

## 许可全文

下列来源以 MIT 许可发布，标准 MIT 许可文本如下（版权人见上表，逐一适用）：

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

gstack/Hermes 核心仓库为 Apache-2.0；本项目仅借鉴其 SKILL.md 中标注为 CC0 / 无协议约束的方法要点并完全重写，
未内置其 Apache-2.0 正文。如各来源对致谢方式有异议，请提 issue，我们将及时调整或移除。
