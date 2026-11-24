import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markdownToDocx } from "../src/export/docx.js";

/* 手写的 docx（zip + 几个 XML）。测的是"真的是个能打开的 docx"：
 * 用系统 unzip 解出来，检查必需的部件和内容都在。*/

describe("纪要导出 Word", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("生成的是合法 zip，部件齐全，中文内容原样在里面", async () => {
    const buffer = markdownToDocx("## 讨论要点\n- 续约价格谈到九折\n- 周五前发报价\n\n> 明天十点给张总打电话\n\n普通段落",
      "拜访张总：谈续约", "2026-09-20 由 VoxMind 生成");
    dir = await mkdtemp(join(tmpdir(), "voxmind-docx-"));
    const path = join(dir, "out.docx");
    await writeFile(path, buffer);

    const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).trim().split("\n");
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("word/document.xml");
    expect(names).toContain("word/styles.xml");
    expect(names).toContain("word/numbering.xml");

    const xml = execFileSync("unzip", ["-p", path, "word/document.xml"], { encoding: "utf8" });
    expect(xml).toContain("拜访张总：谈续约");
    expect(xml).toContain("续约价格谈到九折");
    expect(xml).toContain("讨论要点");
    // 项目符号走列表样式，引用走引用样式
    expect(xml).toContain('w:pStyle w:val="ListParagraph"');
    expect(xml).toContain('w:pStyle w:val="Quote"');
  });

  it("XML 里的特殊字符转义掉，不会把文档写坏", async () => {
    const buffer = markdownToDocx("预算 < 10 万 & 要求 > 3 个月", "标题 & 副标题");
    dir = await mkdtemp(join(tmpdir(), "voxmind-docx2-"));
    const path = join(dir, "out.docx");
    await writeFile(path, buffer);
    const xml = execFileSync("unzip", ["-p", path, "word/document.xml"], { encoding: "utf8" });
    expect(xml).toContain("预算 &lt; 10 万 &amp; 要求 &gt; 3 个月");
    expect(xml).not.toContain("预算 < 10");
  });
});
