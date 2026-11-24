# 经济档本地识别服务。镜像构建时下载模型（约 230MB 解压后），运行时不联网。
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir sherpa-onnx==1.13.8 numpy fastapi "uvicorn[standard]"
ARG MODEL=sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09
RUN mkdir -p /models && curl -fsSL "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2" \
  | tar xj -C /models && mv /models/${MODEL} /models/sensevoice
WORKDIR /app
COPY server.py .
USER nobody
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
