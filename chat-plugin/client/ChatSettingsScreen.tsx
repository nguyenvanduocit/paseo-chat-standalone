import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Loading, SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { chatSettings, type ChatSettingsValues } from "../shared/chat";
import { setMe, useMe } from "./me";
import { SignalsSettings } from "./SignalsSettings";
import { AsMe } from "./WhoAmI";

const notifyOptions = [
  { value: "dm-and-mentions", label: "Tin nhắn riêng và khi được nhắc tên" },
  { value: "all", label: "Mọi tin mới" },
  { value: "off", label: "Tắt" },
] as const;

// Who is at this client, then Paseo's own settings rows; a change saves at once, as Paseo's settings do. Signals follow.
export function ChatSettingsScreen({ theme, navigation }: PluginSurfaceProps) {
  const settings = useSettings(chatSettings);
  const me = useMe();
  if (settings.status === "loading") return <Loading />;
  if (settings.status !== "ready") {
    return <SettingsSection title="Workspace Chat">
      <SettingsCard><SettingsRow label="Không đọc được cấu hình" error={settings.error} /></SettingsCard>
    </SettingsSection>;
  }
  const { values, revision, saving, saveError } = settings;
  const change = (next: Partial<ChatSettingsValues>) => { void settings.save({ ...values, ...next }, revision); };
  return <>
    <SettingsSection title="Workspace Chat" info="Thông báo là cấu hình chung của daemon, cho mọi người dùng nó.">
      <SettingsCard>
        {me === null ? null : <SettingsAction label={`Bạn đang dùng Chat là ${me}`} hint="Client này gửi tin và chạy AI Assistant theo tên này."
          actionLabel="Đổi người" onPress={() => setMe(null)} />}
        <SettingsSelect
          label="Thông báo khi có tin mới"
          value={values.notify}
          options={notifyOptions}
          disabled={saving}
          onValueChange={notify => change({ notify })}
        />
        <SettingsSwitch
          label="Cửa sổ trả lời nhanh"
          hint="Hiện khi có tin khẩn nhắn riêng hoặc nhắc tên bạn; tin thường và khi tắt thì chỉ hiện thông báo."
          value={values.autoOpen}
          disabled={saving}
          error={saveError}
          onValueChange={autoOpen => change({ autoOpen })}
        />
      </SettingsCard>
    </SettingsSection>
    <AsMe colors={theme.colors}><SignalsSettings theme={theme} navigation={navigation} /></AsMe>
  </>;
}
