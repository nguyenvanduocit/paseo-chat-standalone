import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { handlePattern, joinDaemon, readDaemonPeople } from "../shared/chat";
import { Button, ErrorLine, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { setMe, useMe } from "./me";
import { fontSize, fontWeight, radius, spacing } from "./paseo-theme";

// Who is at this client (docs/standalone.md): someone who picked themselves on this daemon before, or a new handle.
// Picking joins the daemon, which lists the person in chat and runs their AI Assistant from then on.
export function WhoAmI({ colors }: { colors: Colors }) {
  const readPeople = useRpc(readDaemonPeople);
  const join = useRpc(joinDaemon);
  const [people, setPeople] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readPeople({}).then(next => { if (!cancelled) setPeople(next.people); }, failure => { if (!cancelled) setError(userErrorMessage(failure)); });
    return () => { cancelled = true; };
  }, [readPeople]);

  const pick = async (handle: string) => {
    setBusy(true);
    setError(null);
    try {
      await join({ as: handle });
      setMe(handle);
    } catch (failure) {
      setError(userErrorMessage(failure));
      setBusy(false);
    }
  };
  const handle = typed.trim();
  const valid = handlePattern.test(handle);

  return <View style={{ padding: spacing[6], gap: spacing[4], maxWidth: 420 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: fontSize.lg, fontWeight: fontWeight.medium }}>Bạn là ai?</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base }}>
      Daemon này dùng chung cho nhiều người. Chọn tên của bạn trên client này: tin bạn gửi, AI Assistant và persona đi theo tên đó.
    </Text>
    {people?.length ? <View style={{ gap: spacing[2] }}>
      {people.map(person => <Button key={person} colors={colors} variant="ghost" icon="User" label={person} disabled={busy}
        accessibilityLabel={`Tôi là ${person}`} onPress={() => { void pick(person); }} />)}
    </View> : null}
    <View style={{ gap: spacing[2] }}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.base }}>{people?.length ? "Hoặc tên mới" : "Tên của bạn"}</Text>
      <TextInput value={typed} onChangeText={setTyped} placeholder="vd. nam" autoCapitalize="none" autoCorrect={false}
        accessibilityLabel="Tên chat của bạn" editable={!busy} onSubmitEditing={() => { if (valid) void pick(handle); }}
        style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: spacing[2], fontSize: fontSize.base }} />
      {handle && !valid ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm }}>Chỉ gồm chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.</Text> : null}
      <Button colors={colors} variant="primary" label="Dùng tên này" disabled={busy || !valid} onPress={() => { void pick(handle); }} />
    </View>
    {error === null ? null : <ErrorLine colors={colors} message={error} />}
  </View>;
}

// `children` once the person at this client is picked, else the picker.
export function AsMe({ colors, children }: { colors: Colors; children: ReactNode }) {
  return useMe() === null ? <WhoAmI colors={colors} /> : <>{children}</>;
}
