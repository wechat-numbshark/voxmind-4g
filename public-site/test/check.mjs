import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initialState, reduce } from "../voxmind/demo/flow.js";
import { seed, scenarios } from "../voxmind/demo/seed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedHosts = new Set([
  "github.com",
  "m.tb.cn",
  "buildwithneo.cn",
  "feishubanlv.com",
  "wa.me",
  "www.douyin.com",
  "127.0.0.1:8765",
  "www.w3.org",
]);

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full));
    else out.push(full);
  }
  return out;
}

function sentences(text) {
  return text.split(/(?<=[。！？.!?])|\n+/);
}

test("demo flow is deterministic and stays local across all scenarios", () => {
  for (const key of Object.keys(scenarios)) {
    const item = scenarios[key];
    const first = ["show-speech", "propose", "confirm", "reset"].reduce(
      (state, action) => reduce(state, action, item),
      initialState(),
    );
    const second = ["show-speech", "propose", "confirm", "reset"].reduce(
      (state, action) => reduce(state, action, item),
      initialState(),
    );
    assert.deepEqual(first, second);
    assert.deepEqual(first, initialState());
  }

  let state = initialState();
  state = reduce(state, "confirm", seed);
  assert.equal(state.step, "ready");
  state = reduce(state, "show-speech", seed);
  assert.equal(state.speech.zh, seed.speech.zh);
  state = reduce(state, "propose", seed);
  assert.equal(state.proposal.en.title, "Booth follow-up");
  state = reduce(state, "confirm", seed);
  assert.equal(state.record.id, "SYN-1042");
  assert.equal(state.record.ja.state.includes("デモページ"), true);
  state = reduce(state, "reset", seed);
  assert.equal(state.record, null);
  assert.equal(state.speech, null);
});

test("published pages stay free of secrets, media capture, and self-deprecation", async () => {
  const files = await filesUnder(root);
  const banned = [
    /sslip\.io/i,
    /voxmind-evt-v1-/,
    /9971e3de-6976-4b07-ac23-16d8b307c9a6/,
    /532c77a9-ece2-4a5e-af35-55641a963773/,
    /e8c5cbfb-d931-4c89-a7aa-d2a54a75b07a/,
    /cb799014-341e-419d-8aac-6fa8c257d302/,
    /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/,
    /getUserMedia|MediaRecorder|mediaDevices/,
    /new WebSocket|EventSource|XMLHttpRequest|\bfetch\s*\(/,
    /<audio\b|<video\b/i,
    /\.(?:mp3|wav|ogg|mp4|pcm|webm)\b/i,
    /笨重|bulky|待优化|优化空间|needs improvement|欠陥|voluminoso|sperrig/,
  ];
  for (const file of files) {
    if (file.endsWith("check.mjs")) continue;
    const info = await stat(file);
    assert.ok(info.size < 8_000_000, path.relative(root, file));
    if (/\.(png|jpg|jpeg|webp)$/i.test(file)) continue;
    const text = await readFile(file, "utf8");
    for (const pattern of banned) {
      assert.equal(pattern.test(text), false, `${path.relative(root, file)} matched ${pattern}`);
    }
    for (const match of text.matchAll(/https?:\/\/([^/\s"'#)]+)/g)) {
      const host = match[1].replace(/[^a-z0-9.:-].*$/i, "");
      assert.ok(allowedHosts.has(host), `${path.relative(root, file)} host ${host}`);
    }
    for (const sentence of sentences(text)) {
      if (sentence.includes("开源")) {
        assert.match(sentence, /不是/);
      }
      if (/open[- ]source/i.test(sentence)) {
        const qualified = /not an open-source license/i.test(sentence)
          || sentence.includes("不是")
          || sentence.includes("ではありません");
        assert.equal(qualified, true, sentence);
      }
      if (sentence.includes("オープンソース")) {
        assert.match(sentence, /ではありません/);
      }
    }
  }
});

test("routes and assets are relative", async () => {
  const intro = await readFile(path.join(root, "voxmind/index.html"), "utf8");
  const demo = await readFile(path.join(root, "voxmind/demo/index.html"), "utf8");
  assert.match(intro, /href="demo\/"/);
  assert.match(intro, /src="assets\/voxmind-hero\.jpg"/);
  assert.match(intro, /src="assets\/voxmind-overview\.jpg"/);
  assert.match(intro, /src="assets\/voxmind-vs-plaud\.jpg"/);
  assert.match(intro, /src="assets\/wechat-qr\.jpg"/);
  assert.match(demo, /href="\.\.\/"/);
  assert.match(demo, /href="\.\.\/site\.css"/);
  assert.match(demo, /src="demo\.js"/);
  assert.doesNotMatch(intro, /(?:src|href)="\/voxmind/);
  assert.doesNotMatch(demo, /(?:src|href)="\/voxmind/);
});
