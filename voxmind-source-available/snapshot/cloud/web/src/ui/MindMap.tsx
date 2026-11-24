import { useMemo, useRef } from "react";
import { Download } from "lucide-react";
import { useToast } from "./kit.tsx";

export interface MindNode { title: string; children?: MindNode[] }

/* 思维导图：中心在左，分支向右展开（横向树）。
 * 纯 SVG 画，能直接下载成 SVG，也能转成 PNG 发给别人。颜色：每个一级分支一种，沿用控制台的风险色，但这里只做区分，不表示风险。*/

const COL = 188;          // 每一层的横向间距
const ROW = 34;           // 每个叶子的竖向间距
const BRANCH = ["#2766AE", "#0A6E64", "#E9A21B", "#E0604A", "#1E7A4B", "#6B4FA3", "#445561"];

interface Placed { node: MindNode; x: number; y: number; depth: number; color: string; w: number; parent?: Placed }

/** 中文按一个字 15px 估宽，英文数字 8px；节点最宽 170 */
function textWidth(s: string) {
  let w = 0;
  for (const ch of s) w += /[⺀-￿]/.test(ch) ? 15 : 8;
  return Math.min(170, w + 20);
}

function layout(root: MindNode) {
  const placed: Placed[] = [];
  let leaf = 0;
  const walk = (node: MindNode, depth: number, color: string, parent?: Placed): Placed => {
    const p: Placed = { node, depth, color, x: 16 + depth * COL, y: 0, w: textWidth(node.title), ...(parent ? { parent } : {}) };
    placed.push(p);
    const kids = node.children ?? [];
    if (!kids.length) { p.y = 24 + leaf++ * ROW; return p; }
    const ys = kids.map((c, i) => walk(c, depth + 1, depth === 0 ? BRANCH[i % BRANCH.length]! : color, p).y);
    p.y = (ys[0]! + ys[ys.length - 1]!) / 2;
    return p;
  };
  walk(root, 0, "#12202A");
  const width = Math.max(...placed.map((p) => p.x + p.w)) + 16;
  const height = Math.max(48, leaf * ROW + 24);
  return { placed, width, height };
}

function clip(s: string, w: number) {
  let out = "", acc = 20;
  for (const ch of s) {
    acc += /[⺀-￿]/.test(ch) ? 15 : 8;
    if (acc > w) return `${out}…`;
    out += ch;
  }
  return out;
}

export function MindMap({ tree, name }: { tree: MindNode; name: string }) {
  const toast = useToast();
  const svgRef = useRef<SVGSVGElement>(null);
  const { placed, width, height } = useMemo(() => layout(tree), [tree]);

  function svgText() {
    const svg = svgRef.current!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(svg);
  }
  function download(blob: Blob, ext: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function savePng() {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText()], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width * 2; canvas.height = height * 2;          // 2 倍，发到手机上不糊
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? download(b, "png") : toast("浏览器不支持导出图片", true)), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("导出图片失败", true); };
    img.src = url;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div style={{ overflowX: "auto", border: "1px solid var(--rule)", borderRadius: 8, background: "#fff" }}>
        <svg ref={svgRef} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`思维导图：${tree.title}`}
             style={{ display: "block", fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif" }}>
          {placed.filter((p) => p.parent).map((p, i) => {
            const a = p.parent!;
            const x1 = a.x + a.w, y1 = a.y, x2 = p.x, y2 = p.y, mx = (x1 + x2) / 2;
            return <path key={i} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={p.color} strokeWidth={p.depth === 1 ? 2.5 : 1.5} opacity={0.8} />;
          })}
          {placed.map((p, i) => (
            <g key={i}>
              <rect x={p.x} y={p.y - 13} width={p.w} height={26} rx={p.depth === 0 ? 13 : 6}
                    fill={p.depth === 0 ? "#12202A" : p.depth === 1 ? p.color : "#fff"}
                    stroke={p.depth > 1 ? p.color : "none"} strokeWidth={1} />
              <text x={p.x + 10} y={p.y + 5} fontSize={p.depth === 0 ? 14 : 13} fontWeight={p.depth < 2 ? 600 : 500}
                    fill={p.depth < 2 ? "#fff" : "#12202A"}>{clip(p.node.title, p.w)}</text>
              <title>{p.node.title}</title>
            </g>
          ))}
        </svg>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn sm" onClick={savePng}><Download aria-hidden />下载图片</button>
        <button className="btn sm" onClick={() => download(new Blob([svgText()], { type: "image/svg+xml" }), "svg")}><Download aria-hidden />下载 SVG</button>
      </div>
    </div>
  );
}
