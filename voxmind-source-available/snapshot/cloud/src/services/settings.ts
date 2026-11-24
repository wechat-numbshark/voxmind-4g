import { DEFAULT_PREFS, type QualityTier, type UserSettings } from "../domain.js";
import type { Repository } from "../store/repository.js";

export const DEFAULT_WAKE_WORD = "小沃小沃";

/** 用户没存过设置时的默认值。档位默认取部署配置，定时开关机默认关闭 */
export class SettingsService {
  constructor(private readonly repository: Repository, private readonly defaultTier: QualityTier) {}

  async get(userId: string): Promise<UserSettings> {
    return (await this.repository.getUserSettings(userId)) ?? {
      userId, tier: this.defaultTier, wakeWord: DEFAULT_WAKE_WORD, retentionDays: 0, ledMode: "designed", prefs: DEFAULT_PREFS,
      schedule: { enabled: false, offAt: "23:00", onAt: "07:00", mode: "hard" },
      updatedAt: new Date(0).toISOString(),
    };
  }

  async save(settings: Omit<UserSettings, "updatedAt">) {
    return this.repository.saveUserSettings({ ...settings, updatedAt: new Date().toISOString() });
  }
}
