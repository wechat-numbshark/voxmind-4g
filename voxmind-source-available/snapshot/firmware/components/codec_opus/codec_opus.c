#include "codec_opus.h"

#include <stdbool.h>
#include <string.h>
#include "esp_log.h"
#include "esp_random.h"
#include "esp_opus_enc.h"

static const char *TAG = "codec_opus";

/* 一个 Ogg page 最多塞多少个 Opus 包再落盘——纯粹为了减小 27 字节/page 的
 * 头部开销分摊到更多数据上，不是协议要求。100 包 * 最多 2 个 lacing 分段
 * = 200 segments，safely under 协议上限 255，不用另外算 segment 计数。*/
#define PAGE_MAX_PACKETS 100
#define PAGE_MAX_BYTES   8192
#define PAGE_OUT_CAP     (PAGE_MAX_BYTES + 27 + 300)
#define OUT_PKT_CAP      1500 /* > RFC 6716 单包理论上限 1275 字节 */
#define RESIDUAL_CAP     960  /* 覆盖到 60ms@16kHz，留足余量，实际用 320 */

typedef struct {
    void   *enc_hd;
    int     frame_samples; /* 一帧输入多少个采样点(单声道) */
    int16_t residual[RESIDUAL_CAP];
    size_t  residual_len;

    uint8_t out_pkt[OUT_PKT_CAP];

    uint32_t serial;
    uint32_t page_seq;
    int64_t  granule;
    unsigned frames_total;
    unsigned frames_empty;

    uint8_t  page_data[PAGE_MAX_BYTES];
    size_t   page_data_len;
    uint16_t page_pkt_len[PAGE_MAX_PACKETS];
    int      page_pkt_count;

    uint8_t page_out[PAGE_OUT_CAP];
} opus_ctx_t;

static opus_ctx_t s_ctx;
static uint32_t s_crc_table[256];
static bool s_crc_ready;

static void crc_table_init(void)
{
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t crc = i << 24;
        for (int j = 0; j < 8; j++) crc = (crc & 0x80000000UL) ? (crc << 1) ^ 0x04c11db7UL : (crc << 1);
        s_crc_table[i] = crc;
    }
    s_crc_ready = true;
}

/* Ogg 用的是自己那套 CRC-32（多项式 0x04c11db7，不反射，初值/终值都是 0），
 * 跟 zlib/以太网的 CRC32 不是一回事，不能偷懒复用现成的 crc32()。*/
static uint32_t ogg_crc(const uint8_t *data, size_t len)
{
    uint32_t crc = 0;
    for (size_t i = 0; i < len; i++) crc = (crc << 8) ^ s_crc_table[((crc >> 24) & 0xff) ^ data[i]];
    return crc;
}

static void put_le16(uint8_t *p, uint16_t v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; }
static void put_le32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xff; }
static void put_le64(uint8_t *p, int64_t v)  { uint64_t u = (uint64_t)v; for (int i = 0; i < 8; i++) p[i] = (u >> (8 * i)) & 0xff; }

/* 把 page_pkt_len[] 里记的每个包长度按 Ogg lacing 规则(每 255 一段，不足
 * 255 的一段收尾；正好是 255 的倍数要多补一个 0 长度段做终止)展开成
 * segment table。*/
static int build_segment_table(uint8_t *segtab, int max_segs)
{
    int n = 0;
    for (int p = 0; p < s_ctx.page_pkt_count; p++) {
        size_t remaining = s_ctx.page_pkt_len[p];
        uint8_t seg;
        do {
            seg = remaining >= 255 ? 255 : (uint8_t)remaining;
            if (n >= max_segs) return -1;
            segtab[n++] = seg;
            remaining -= seg;
        } while (seg == 255);
    }
    return n;
}

static esp_err_t flush_page(FILE *file, uint8_t header_type_flags)
{
    if (s_ctx.page_pkt_count == 0 && header_type_flags == 0) return ESP_OK;
    uint8_t segtab[300];
    int nseg = build_segment_table(segtab, sizeof(segtab));
    if (nseg < 0) { ESP_LOGE(TAG, "segment table 溢出"); return ESP_FAIL; }
    size_t header_len = 27 + (size_t)nseg;
    size_t total = header_len + s_ctx.page_data_len;
    if (total > sizeof(s_ctx.page_out)) { ESP_LOGE(TAG, "page 缓冲区不够大"); return ESP_FAIL; }

    uint8_t *out = s_ctx.page_out;
    memcpy(out, "OggS", 4);
    out[4] = 0;
    out[5] = header_type_flags;
    put_le64(out + 6, s_ctx.granule);
    put_le32(out + 14, s_ctx.serial);
    put_le32(out + 18, s_ctx.page_seq);
    put_le32(out + 22, 0);
    out[26] = (uint8_t)nseg;
    memcpy(out + 27, segtab, nseg);
    memcpy(out + header_len, s_ctx.page_data, s_ctx.page_data_len);
    put_le32(out + 22, ogg_crc(out, total));

    size_t written = fwrite(out, 1, total, file);
    s_ctx.page_seq++;
    s_ctx.page_pkt_count = 0;
    s_ctx.page_data_len = 0;
    return written == total ? ESP_OK : ESP_FAIL;
}

static esp_err_t add_packet(FILE *file, const uint8_t *data, size_t len)
{
    if (s_ctx.page_pkt_count > 0 &&
        (s_ctx.page_pkt_count >= PAGE_MAX_PACKETS || s_ctx.page_data_len + len > PAGE_MAX_BYTES)) {
        esp_err_t e = flush_page(file, 0x00);
        if (e != ESP_OK) return e;
    }
    if (s_ctx.page_data_len + len > PAGE_MAX_BYTES) return ESP_FAIL; /* 单包异常大，配置范围内不应发生 */
    memcpy(s_ctx.page_data + s_ctx.page_data_len, data, len);
    s_ctx.page_data_len += len;
    s_ctx.page_pkt_len[s_ctx.page_pkt_count++] = (uint16_t)len;
    return ESP_OK;
}

esp_err_t codec_opus_init(int sample_rate, int bitrate, int complexity)
{
    if (!s_crc_ready) crc_table_init();

    esp_opus_enc_config_t cfg = ESP_OPUS_ENC_CONFIG_DEFAULT();
    cfg.sample_rate      = sample_rate;
    cfg.channel          = ESP_AUDIO_MONO;
    cfg.bits_per_sample  = ESP_AUDIO_BIT16;
    cfg.bitrate          = bitrate;
    cfg.frame_duration   = ESP_OPUS_ENC_FRAME_DURATION_20_MS;
    cfg.application_mode = ESP_OPUS_ENC_APPLICATION_VOIP;
    cfg.complexity       = complexity;
    cfg.enable_fec       = false;
    /* DTX 只有 VOIP + 8/12/16kHz + 帧长>5ms 才生效，正好是我们的配置——
     * 录音里大段安静/环境音会被编码成极小的包，这对"存 71 小时"很关键。*/
    cfg.enable_dtx       = true;
    cfg.enable_vbr       = true;

    esp_audio_err_t r = esp_opus_enc_open(&cfg, sizeof(cfg), &s_ctx.enc_hd);
    if (r != ESP_AUDIO_ERR_OK) {
        ESP_LOGE(TAG, "esp_opus_enc_open 失败 (%d)", r);
        return ESP_FAIL;
    }
    int in_size = 0, out_size = 0;
    esp_opus_enc_get_frame_size(s_ctx.enc_hd, &in_size, &out_size);
    s_ctx.frame_samples = in_size / (int)sizeof(int16_t);
    if (s_ctx.frame_samples <= 0 || s_ctx.frame_samples > RESIDUAL_CAP || out_size > OUT_PKT_CAP) {
        ESP_LOGE(TAG, "编码器帧尺寸超出预留缓冲区 in=%d out=%d", in_size, out_size);
        esp_opus_enc_close(s_ctx.enc_hd);
        s_ctx.enc_hd = NULL;
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "Opus 编码器就绪：%dHz 单声道 %dbps 每帧%d采样(20ms)",
             sample_rate, bitrate, s_ctx.frame_samples);
    return ESP_OK;
}

/* 换音质：关掉再按新参数开一个编码器。只能在两个块文件之间调用——
 * 文件写到一半换编码器，那个块的 Ogg 页会前后不一致，解码端直接报错。*/
esp_err_t codec_opus_reconfigure(int sample_rate, int bitrate, int complexity)
{
    /* A failed quality change must leave the working encoder available. The
     * caller falls back to the previous settings; closing it first defeated that. */
    void *previous = s_ctx.enc_hd;
    int previous_frame_samples = s_ctx.frame_samples;
    s_ctx.enc_hd = NULL;
    esp_err_t result = codec_opus_init(sample_rate, bitrate, complexity);
    if (result == ESP_OK) {
        if (previous) esp_opus_enc_close(previous);
    } else {
        s_ctx.enc_hd = previous;
        s_ctx.frame_samples = previous_frame_samples;
    }
    return result;
}

esp_err_t codec_opus_begin_file(FILE *file)
{
    if (!s_ctx.enc_hd) return ESP_ERR_INVALID_STATE;
    s_ctx.residual_len = 0;
    s_ctx.page_seq = 0;
    s_ctx.granule = 0;
    s_ctx.page_data_len = 0;
    s_ctx.page_pkt_count = 0;
    s_ctx.frames_total = 0;
    s_ctx.frames_empty = 0;
    s_ctx.serial = esp_random();
    /* 编码器状态故意不在文件之间重置：Opus 包本身可独立解码，状态延续反而
     * 让 chunk 边界处压缩更好。*/

    uint8_t head[19];
    memcpy(head, "OpusHead", 8);
    head[8] = 1;                        /* version */
    head[9] = 1;                        /* channel count = mono */
    put_le16(head + 10, 0);             /* pre-skip */
    put_le32(head + 12, 16000);         /* 原始采样率，仅供参考 */
    put_le16(head + 16, 0);             /* output gain */
    head[18] = 0;                       /* channel mapping family 0 */
    esp_err_t e = add_packet(file, head, sizeof(head));
    if (e == ESP_OK) e = flush_page(file, 0x02 /* BOS */);
    if (e != ESP_OK) return e;

    uint8_t tags[8 + 4 + 7 + 4];
    memcpy(tags, "OpusTags", 8);
    put_le32(tags + 8, 7);
    memcpy(tags + 12, "voxmind", 7);
    put_le32(tags + 19, 0);
    e = add_packet(file, tags, sizeof(tags));
    if (e == ESP_OK) e = flush_page(file, 0x00);
    return e;
}

static esp_err_t encode_one_frame(FILE *file, const int16_t *pcm)
{
    esp_audio_enc_in_frame_t in_frame = {
        .buffer = (uint8_t *)(const void *)pcm,
        .len = (uint32_t)(s_ctx.frame_samples * sizeof(int16_t)),
    };
    esp_audio_enc_out_frame_t out_frame = { .buffer = s_ctx.out_pkt, .len = sizeof(s_ctx.out_pkt) };
    esp_audio_err_t r = esp_opus_enc_process(s_ctx.enc_hd, &in_frame, &out_frame);
    if (r != ESP_AUDIO_ERR_OK) { ESP_LOGW(TAG, "opus 编码失败 (%d)", r); return ESP_FAIL; }
    s_ctx.granule += 960; /* Ogg/Opus 规定 granule 单位固定是"48kHz 等效采样数"，跟实际采样率无关；20ms = 960 */
    s_ctx.frames_total++;
    if (out_frame.encoded_bytes == 0) s_ctx.frames_empty++;
    return add_packet(file, s_ctx.out_pkt, out_frame.encoded_bytes);
}

esp_err_t codec_opus_write_pcm(FILE *file, const int16_t *pcm, size_t num_samples)
{
    if (!s_ctx.enc_hd) return ESP_ERR_INVALID_STATE;
    size_t idx = 0;
    while (idx < num_samples) {
        size_t need = (size_t)s_ctx.frame_samples - s_ctx.residual_len;
        size_t take = (num_samples - idx) < need ? (num_samples - idx) : need;
        memcpy(s_ctx.residual + s_ctx.residual_len, pcm + idx, take * sizeof(int16_t));
        s_ctx.residual_len += take;
        idx += take;
        if (s_ctx.residual_len == (size_t)s_ctx.frame_samples) {
            esp_err_t e = encode_one_frame(file, s_ctx.residual);
            s_ctx.residual_len = 0;
            if (e != ESP_OK) return e;
        }
    }
    return ESP_OK;
}

esp_err_t codec_opus_end_file(FILE *file)
{
    if (!s_ctx.enc_hd) return ESP_ERR_INVALID_STATE;
    if (s_ctx.residual_len > 0) {
        /* 正常配置下 (5s 整数倍 20ms 帧) 不会走到这里；防御性地补零凑满
         * 最后一帧，不能因为差几个采样点就把最后一点声音丢掉。*/
        memset(s_ctx.residual + s_ctx.residual_len, 0,
               (s_ctx.frame_samples - s_ctx.residual_len) * sizeof(int16_t));
        esp_err_t e = encode_one_frame(file, s_ctx.residual);
        s_ctx.residual_len = 0;
        if (e != ESP_OK) return e;
    }
    ESP_LOGI(TAG, "本块 %u 帧，DTX 空包 %u", s_ctx.frames_total, s_ctx.frames_empty);
    return flush_page(file, 0x04 /* EOS，哪怕没剩包也要发一个空的收尾页，标准允许 */);
}
