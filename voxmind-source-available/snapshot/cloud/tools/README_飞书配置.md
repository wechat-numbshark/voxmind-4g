# 飞书 CLI 配置（一次性，约 5 分钟）

配好之后，任何 Markdown 文件都能一条命令推成飞书云文档：

```bash
node cloud/tools/lark_push_doc.mjs 交付/VoxMind_打样到开发_全流程指导.md
```

---

## 为什么不用现成的 "lark-cli"

项目里已经装了**飞书官方 Node SDK** `@larksuiteoapi/node-sdk`（云端推卡片就是用它）。
直接复用，不用再装别的东西。`lark_push_doc.mjs` 走官方**导入接口**，
Markdown → 云文档的排版转换由飞书服务端完成，比自己拼 block 准得多。

---

## 第 1 步：创建自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)（用你的飞书账号登录）
2. 点「创建企业自建应用」
3. 名称随便填，比如 `VoxMind 文档助手`

## 第 2 步：开权限（关键，漏了会报 99991663）

进应用 →「权限管理」→ 搜索并开通这几个：

| 权限 | 作用 |
|---|---|
| `drive:drive` | 上传文件、创建导入任务 |
| `docx:document` | 创建/写入云文档 |
| `drive:file` （或「查看、评论、编辑和管理云空间中所有文件」） | 落盘到你的空间 |

## 第 3 步：拿凭证

「凭证与基础信息」页面，复制两个值：

- **App ID**（`cli_` 开头）
- **App Secret**

## 第 4 步：发布版本

「版本管理与发布」→ 创建版本 → 申请发布。
**个人自建应用通常自己就能通过**；如果是企业账号，可能要管理员审批。

> ⚠ **不发布版本，权限不生效**，调接口会一直报权限错误。

## 第 5 步：填进 .env

```bash
cp cloud/.env.example cloud/.env
```

编辑 `cloud/.env`，填这两行：

```
LARK_APP_ID=cli_xxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxx
```

> 🔒 **凭证请你自己填，不要发给任何人（包括发在对话里）。**
> `cloud/.env` 已在 `.gitignore` 里，不会被提交。

## 第 6 步：验证

```bash
cd /Volumes/neo/projects/voxmind
node cloud/tools/lark_push_doc.mjs 交付/VoxMind_打样到开发_全流程指导.md
```

成功会打印：

```
① 上传 …
② 创建导入任务（md → 云文档）…
③ 等待转换…
✅ 完成
   链接: https://xxx.feishu.cn/docx/xxxxxxxx
```

---

## 可选：指定放到哪个文件夹

不指定的话文档落在**你的空间根目录**。想放进特定文件夹：

1. 在飞书里打开那个文件夹，看地址栏 `https://xxx.feishu.cn/drive/folder/<这段就是token>`
2. 作为第二个参数传进去：

```bash
node cloud/tools/lark_push_doc.mjs 文档.md fldcnXXXXXXXX
```

或写进 `cloud/.env`：`LARK_FOLDER_TOKEN=fldcnXXXXXXXX`

> ⚠ 文件夹要**共享给这个应用**（文件夹 → 更多 → 添加协作者 → 搜应用名），否则没权限写入。

---

## 常见报错

| 报错 | 原因 | 解决 |
|---|---|---|
| `99991663` / permission denied | 权限没开或版本没发布 | 回第 2、4 步 |
| `invalid app_id or app_secret` | 凭证填错、有空格 | 重新复制，注意别带空格 |
| 上传成功但导入失败 | 文件夹没共享给应用 | 见上面「可选」那节 |
| `Cannot find package` | 依赖没装 | `cd cloud && npm install` |
