# VoxMind public pages

Static introduction and a synthetic click-through demo. Nothing here is a server, a device connection, or a Feishu write.

The pages are meant to be mounted later as:

- `https://feishubanlv.com/voxmind`
- `https://feishubanlv.com/voxmind/demo/`

This directory does not deploy them, and it does not update the Neo project card.

## Preview

From the repository root:

```bash
cd public-site
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/voxmind/` and `http://127.0.0.1:8765/voxmind/demo/`.

Links inside the pages are relative, so the same files work under `/voxmind/` and `/voxmind/demo/`.

## Mount

Copy `public-site/voxmind/` to the static directory the existing site already uses, for example `/opt/feishu-saas/app/static/voxmind/`. Point nginx only at those files:

```nginx
location = /voxmind {
    return 301 /voxmind/;
}
location /voxmind/ {
    alias /opt/feishu-saas/app/static/voxmind/;
}
```

`/voxmind/demo/` is the `demo/` directory inside that folder. Do not proxy it to the VoxMind cloud, a device, or a login service. Do not run `snapshot/cloud`.

Updating `https://buildwithneo.cn` is a separate admin edit. This tree does not do it.

## Check

```bash
node --test public-site/test/check.mjs
```
