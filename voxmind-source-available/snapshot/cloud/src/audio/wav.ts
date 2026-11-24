/** 16kHz 单声道 PCM 加上 WAV 头。设备上传的是 Ogg/Opus，解码后就是这种裸 PCM；
 *  浏览器回放和 ASR 接口都要求带头的 WAV。*/
/** 只生成 44 字节 WAV 头。导出大段录音时按块流式写出，不把整段音频读进内存。 */
export function wavHeader(dataBytes: number, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function pcm16MonoToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  return Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
}
