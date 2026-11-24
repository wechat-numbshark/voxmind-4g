#!/usr/bin/env node
/**
 * 把 Markdown 文件推成飞书云文档。
 *
 *   node tools/lark_push_doc.mjs <file.md> [飞书文件夹token]
 *
 * 凭证从环境变量或 cloud/.env 读：LARK_APP_ID / LARK_APP_SECRET
 * 走官方「导入」接口，Markdown→docx 的转换由飞书服务端完成，排版最准。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';

function loadEnv() {
  const f = path.resolve(new URL('../.env', import.meta.url).pathname);
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
}
loadEnv();

const APP_ID = process.env.LARK_APP_ID;
const APP_SECRET = process.env.LARK_APP_SECRET;
const file = process.argv[2];
const folderToken = process.argv[3] || process.env.LARK_FOLDER_TOKEN || '';

if (!APP_ID || !APP_SECRET) {
  console.error('✗ 缺少 LARK_APP_ID / LARK_APP_SECRET');
  console.error('  在 cloud/.env 里填好，或 export 到环境变量。获取方法见 cloud/tools/README_飞书配置.md');
  process.exit(1);
}
if (!file || !fs.existsSync(file)) {
  console.error('用法: node tools/lark_push_doc.mjs <file.md> [文件夹token]');
  process.exit(1);
}

const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
const buf = fs.readFileSync(file);
const name = path.basename(file);
const title = name.replace(/\.md$/i, '');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  console.log(`① 上传 ${name} (${buf.length} 字节)…`);
  const up = await client.drive.v1.file.uploadAll({
    data: {
      file_name: name,
      parent_type: 'explorer',
      parent_node: folderToken || undefined,
      size: buf.length,
      file: fs.createReadStream(file),
    },
  });
  const fileToken = up?.file_token ?? up?.data?.file_token;
  if (!fileToken) throw new Error('上传没拿到 file_token: ' + JSON.stringify(up));
  console.log('② 创建导入任务（md → 云文档）…');
  const point = folderToken
    ? { mount_type: 1, mount_key: folderToken }
    : { mount_type: 1, mount_key: '' };          // 空 = 我的空间根目录
  const task = await client.drive.v1.importTask.create({
    data: { file_extension: 'md', file_token: fileToken, type: 'docx', file_name: title, point },
  });
  const ticket = task?.ticket ?? task?.data?.ticket;
  if (!ticket) throw new Error('没拿到 ticket: ' + JSON.stringify(task));

  console.log('③ 等待转换…');
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const r = await client.drive.v1.importTask.get({ path: { ticket } });
    const res = r?.result ?? r?.data?.result;
    if (!res) continue;
    if (res.job_status === 0) {
      console.log(`\n✅ 完成\n   标题: ${title}\n   链接: ${res.url}\n   token: ${res.token}`);
      process.exit(0);
    }
    if (res.job_status !== 1 && res.job_status !== 2) {
      throw new Error(`导入失败 status=${res.job_status} ${res.job_error_msg || ''}`);
    }
    process.stdout.write('.');
  }
  throw new Error('超时：导入任务 40 次轮询仍未完成');
} catch (e) {
  console.error('\n✗ 失败:', e?.message || e);
  if (String(e).includes('99991663') || String(e).includes('permission'))
    console.error('  → 多半是应用权限没开或没发布版本，见 cloud/tools/README_飞书配置.md 第 2、4 步');
  process.exit(1);
}
