# VoxMind 部署

目标服务器：`EXAMPLE-DEMO-HOST.invalid`。部署使用独立 Compose 项目和 `voxmind-net`，不复用或改写现有业务数据库。

```bash
cp .env.example .env
# 用密码生成器填写 .env，权限 chmod 600
docker compose --env-file .env -f compose.yml up -d --build
docker network connect voxmind-net example-caddy  # 已连接时会提示 exists，可忽略
```

把 `Caddyfile.snippet` 的站点块加入现有 Caddyfile，再验证并 reload。上线门禁：

```bash
curl -fsS https://EXAMPLE-DEMO-HOST.invalid/health
curl -fsS https://EXAMPLE-DEMO-HOST.invalid/ready
docker compose --env-file .env -f compose.yml ps
```

仓库附带 `backup.sh` 和 systemd timer；服务器当前每天 03:20（Asia/Shanghai）备份 PostgreSQL 与 `audio-data`，本机保留 14 天。它能防误删和容器卷损坏，但不等于异地灾备；接入 COS/S3 后还应把备份目录同步到另一故障域。
