#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* Air780E 驱动。
 * 硬件约束（见 docs/10_硬件接线真值表.md）：
 *   - PWRKEY 经 Q2(NPN) 反相：GPIO 拉高 = PWRKEY 被拉低 = 触发
 *   - 串口网络名是 MCU 视角：GPIO15=ESP32 RX、GPIO16=ESP32 TX（board.h 已按实测对齐）
 *   - RESET 脚没接 GPIO，死机只能靠 PWRKEY 长按
 */

typedef enum {
    MODEM_OFF = 0,      // 未上电
    MODEM_BOOTING,      // PWRKEY 已触发，等 STATUS 拉高
    MODEM_READY,        // AT 有响应
    MODEM_PSM,          // 进入省电模式（3µA），DTR 可唤醒
    MODEM_FAULT,        // 无响应
} modem_state_t;

esp_err_t modem_init(void);

/* 开机：GPIO17 拉高 1500ms 再放开，然后等 STATUS。
 * 冷启动到能注册网络要 5~15 秒 —— 所以正常运行中【不要关机】，用 PSM。*/
esp_err_t modem_power_on(uint32_t timeout_ms);

/* 关机：同样是 PWRKEY 脉冲。仅在长期不用/固件升级时调用。*/
esp_err_t modem_power_off(uint32_t timeout_ms);
void modem_prepare_sleep(void);   /* 深睡前钉住电源键、TX、DTR、电源开关几根脚（悬空会误按、白耗电） */

/* 改线 A 的模组电源开关（GPIO46）。cut 返回模组是否真的断了电（STATUS 掉没掉）：
 * 没做改线的板子返回 false，调用方要退回到关射频那一套。*/
bool modem_supply_cut(void);
void modem_supply_restore(void);
bool modem_supply_switch_works(void);   /* 本次开机里 cut 成功过 */

/* 强制关机：PWRKEY 拉住 12 秒。RESET 没接线，这是唯一的死机恢复手段。*/
esp_err_t modem_force_reset(void);

modem_state_t modem_get_state(void);

/* 发 AT 命令，等待 expect（通常 "OK"）。resp 可为 NULL。*/
esp_err_t modem_at(const char *cmd, const char *expect, char *resp, size_t resp_len, uint32_t timeout_ms);

/* PSM：TAU 越长越省电、下行延迟越大。
 * v3 需求建议起步 TAU=1h / Active=30s，实测待机电流后再调。*/
esp_err_t modem_psm_enable(uint32_t tau_sec, uint32_t active_sec);

/* 把 DTR 拉低唤醒模组退出 PSM。恢复时间 1~2 秒（对比冷启动 5~15 秒）。*/
esp_err_t modem_psm_wake(uint32_t timeout_ms);

/* 交出 UART：在用 modem_at() 做完开机后的 AT 准备指令（查 SIM、设 APN、
 * 等网络注册）之后，PPP 拨号前必须调用——把这颗驱动私有的 uart_driver
 * 卸载掉，让 esp_modem 的 DTE 能在同一物理串口上装它自己的驱动实例。
 * 调用后 modem_at() 不再可用，直到下次 modem_init()。*/
esp_err_t modem_release_uart_for_ppp(void);

/* 提速 ESP32↔模组这根串口（升级慢的唯一瓶颈）。只改当前会话，不写模组永久配置：
 * 模组断电重开就回到 115200。失败会自动退回原波特率并返回错误。*/
esp_err_t modem_set_uart_baud(int baud);
/* 当前用的波特率，交给 esp_modem 建 DTE 时要用同一个 */
int modem_uart_baud(void);
