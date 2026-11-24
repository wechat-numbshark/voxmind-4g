"""VoxMind 经济档本地语音识别：SenseVoice-Small（int8）跑在自己的服务器 CPU 上。

POST /asr  请求体：16kHz 单声道 16 位小端 PCM 原始字节
           返回：{"text": "...", "seconds": 音频秒数, "elapsed": 识别用时}
GET  /health

每小时识别几乎零成本，只有服务器月费。需要 4 核 8G 以上；
线程数用 ASR_THREADS 调，默认 = CPU 核数。"""
import os
import time

import numpy as np
import sherpa_onnx
from fastapi import FastAPI, HTTPException, Request

MODEL_DIR = os.environ.get("MODEL_DIR", "/models/sensevoice")
THREADS = int(os.environ.get("ASR_THREADS", str(os.cpu_count() or 2)))

recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=os.path.join(MODEL_DIR, "model.int8.onnx"),
    tokens=os.path.join(MODEL_DIR, "tokens.txt"),
    num_threads=THREADS,
    language="zh",
    use_itn=True,   # 数字、日期写成阿拉伯数字，和云端 qwen3-asr 的输出习惯一致
)

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "threads": THREADS}


@app.post("/asr")
async def asr(request: Request):
    body = await request.body()
    if len(body) < 2 or len(body) % 2:
        raise HTTPException(400, "需要 16kHz 单声道 16 位 PCM")
    samples = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
    started = time.perf_counter()
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return {"text": stream.result.text.strip(), "seconds": len(samples) / 16000,
            "elapsed": round(time.perf_counter() - started, 3)}
