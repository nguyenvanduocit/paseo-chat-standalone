import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMyRpc } from "./me";
import { Icon, Modal, SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { changeSignal, isMine, readSignals, subscriberTarget, type Signal } from "../shared/signals";
import { lastSeen } from "./chat-list";
import { Button, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { fontSize, iconSize, spacing } from "./paseo-theme";
import { useOpenConversation } from "./useOpenConversation";

// Chat settings' Signals section: every signal the team registered, who created it, how
// many of its alerts are firing, when it last changed and who subscribes. The person subscribes their AI Assistant or
// leaves; a signal's creator deletes it. Agents register and subscribe with the chat_signal_* tools (server/signal-tools.ts);
// the chat broker pulls the Grafana alerts whose rule carries the label `signal=<alert>`.

type SignalsView = z.infer<typeof readSignals.output>;
type Action = z.infer<typeof changeSignal.input>["action"];

const pollMs = 15_000;
const when = (ms: number | null) => ms === null ? "chưa có alert nào" : lastSeen(new Date(ms).toISOString());

function useSignals() {
  const read = useMyRpc(readSignals);
  const change = useMyRpc(changeSignal);
  const [view, setView] = useState<SignalsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The alert an action is on its way for.
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const next = await read({});
        if (!cancelled) { setView(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(userErrorMessage(failure));
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollMs);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [read, tick]);

  const act = useCallback(async (alert: string, work: () => Promise<unknown>) => {
    setBusy(alert);
    try {
      await work();
      setError(null);
    } catch (failure) {
      setError(userErrorMessage(failure));
    } finally {
      setBusy(null);
      setTick(value => value + 1);
    }
  }, []);

  return {
    view, error, busy,
    change: (alert: string, action: Action) => act(alert, () => change({ alert, action })),
  };
}

// Who hears a signal: "bob → AI Assistant, alice → agent 3f2a…".
function subscribersLine(signal: Signal, me: string): string {
  if (!signal.subscriptions.length) return "Chưa ai subscribe";
  return `Người subscribe: ${signal.subscriptions.map(subscription =>
    `${subscription.handle === me ? "bạn" : subscription.handle} → ${subscriberTarget(subscription)}`).join(", ")}`;
}

export function SignalsSettings({ theme, navigation }: Pick<PluginSurfaceProps, "theme" | "navigation">) {
  const colors = theme.colors;
  const signals = useSignals();
  const conversation = useOpenConversation(navigation);
  const [mineOnly, setMineOnly] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const me = signals.view?.me ?? "";
  const shown = (signals.view?.signals ?? []).filter(signal => !mineOnly || isMine(signal, me));
  const error = signals.error ?? conversation.error;

  return <SettingsSection title="Signals"
    info="Chat broker kéo alert từ Grafana (GRAFANA_URL của broker) mỗi 30 giây và gộp alert mới của mỗi lần kéo thành một tin trong room signals/<tên>. Agent tạo signal bằng chat_signal_register và subscribe bằng chat_signal_subscribe; ở đây bạn subscribe cho AI Assistant của mình.">
    <SettingsCard>
      <SettingsRow label="Alert đến từ đâu" hint="Alert rule trên Grafana mà chat broker kéo (GRAFANA_URL) gắn nhãn signal=<tên>." />
      <SettingsSwitch label="Chỉ của tôi" hint="Signal bạn tạo hoặc đang subscribe." value={mineOnly} onValueChange={setMineOnly} error={error} />
      {signals.view === null && !signals.error ? <SettingsRow label="Đang tải..." /> : null}
      {signals.view !== null && !shown.length
        ? <SettingsRow label={mineOnly ? "Bạn chưa tạo hay subscribe signal nào" : "Chưa có signal nào"} hint="Một agent tạo signal bằng tool chat_signal_register." />
        : null}
      {shown.map(signal => {
        const mine = signal.subscriptions.find(subscription => subscription.handle === me);
        const disabled = signals.busy === signal.alert;
        return <SettingsRow key={signal.alert} label={signal.alert} hint={[
          `Người tạo: ${signal.createdBy === me ? "bạn" : signal.createdBy} · Đang firing: ${signal.firing} · Thay đổi cuối: ${when(signal.lastChangeAt)}`,
          subscribersLine(signal, me),
        ].join("\n")}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing[1] }}>
            {navigation
              ? <Button colors={colors} variant="ghost" icon="MessagesSquare" label="Mở room" accessibilityLabel={`Mở room của signal ${signal.alert}`}
                disabled={conversation.opening === signal.conversation} onPress={() => { void conversation.open(signal.conversation); }} />
              : null}
            {mine
              ? <Button colors={colors} variant="ghost" icon="BellOff" label="Bỏ subscribe" accessibilityLabel={`Bỏ subscribe signal ${signal.alert}`}
                disabled={disabled} onPress={() => { void signals.change(signal.alert, "unsubscribe"); }} />
              : <Button colors={colors} variant="ghost" icon="Bell" label="Subscribe" accessibilityLabel={`Subscribe signal ${signal.alert} cho AI Assistant của bạn`}
                disabled={disabled} onPress={() => { void signals.change(signal.alert, "subscribe"); }} />}
            {signal.createdBy === me
              ? <Button colors={colors} variant="ghost" icon="Trash2" label="Xóa" accessibilityLabel={`Xóa signal ${signal.alert}`}
                disabled={disabled} onPress={() => setDeleting(signal.alert)} />
              : null}
          </View>
        </SettingsRow>;
      })}
    </SettingsCard>
    {deleting
      ? <ConfirmDelete colors={colors} alert={deleting} onClose={() => setDeleting(null)}
        onConfirm={() => { const alert = deleting; setDeleting(null); void signals.change(alert, "delete"); }} />
      : null}
  </SettingsSection>;
}

function ConfirmDelete({ colors, alert, onConfirm, onClose }: { colors: Colors; alert: string; onConfirm(): void; onClose(): void }) {
  return <Modal title={`Xóa signal ${alert}?`} icon={<Icon name="Trash2" size={iconSize.lg} color={colors.foreground} />} open
    onOpenChange={next => { if (!next) onClose(); }}>
    <Modal.Content contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.base }}>
        Mọi subscription của signal này bị xóa và alert gắn nhãn signal={alert} không vào chat nữa. Lịch sử alert trong room signals/{alert} vẫn còn.
      </Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing[2] }}>
        <Button colors={colors} variant="ghost" label="Hủy" onPress={onClose} />
        <Button colors={colors} variant="primary" icon="Trash2" label="Xóa signal" onPress={onConfirm} />
      </View>
    </Modal.Content>
  </Modal>;
}
