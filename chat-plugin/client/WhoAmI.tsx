import { useHosts, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { readDaemonPeople } from "../shared/chat";
import { Button, ErrorLine, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { adoptHostLabel, setMe, useMe } from "./me";
import { fontSize, fontWeight, spacing } from "./paseo-theme";

// Who is at this client (docs/standalone.md): one of the daemon's people (`CHAT_PEOPLE`). A host connection labelled
// with a person's handle picks them without asking, which is how the mobile app keeps the person across launches.
export function WhoAmI({ colors }: { colors: Colors }) {
  const readPeople = useRpc(readDaemonPeople);
  const hosts = useHosts();
  const [people, setPeople] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    readPeople({}).then(next => { if (!cancelled) setPeople(next.people); }, failure => { if (!cancelled) setError(userErrorMessage(failure)); });
    return () => { cancelled = true; };
  }, [readPeople]);
  useEffect(() => {
    if (people !== null) adoptHostLabel(hosts.map(host => host.label), people);
  }, [hosts, people]);

  return <View style={{ padding: spacing[6], gap: spacing[4], maxWidth: 420 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: fontSize.lg, fontWeight: fontWeight.medium }}>Bạn là ai?</Text>
    <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.base }}>
      Daemon này dùng chung cho nhiều người. Chọn tên của bạn trên client này: tin bạn gửi, AI Assistant và persona đi theo tên đó.
      Trên app mobile, đặt tên kết nối tới daemon trùng tên của bạn để app tự nhận ra bạn.
    </Text>
    {people?.length ? <View style={{ gap: spacing[2] }}>
      {people.map(person => <Button key={person} colors={colors} variant="ghost" icon="User" label={person}
        accessibilityLabel={`Tôi là ${person}`} onPress={() => setMe(person)} />)}
    </View> : null}
    {error === null ? null : <ErrorLine colors={colors} message={error} />}
  </View>;
}

// `children` once the person at this client is picked, else the picker.
export function AsMe({ colors, children }: { colors: Colors; children: ReactNode }) {
  return useMe() === null ? <WhoAmI colors={colors} /> : <>{children}</>;
}
