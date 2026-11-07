import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { claimWorkspace, readWorkspaceOwner } from "../shared/chat";
import { Button, ErrorLine, type Colors } from "./chat-ui";
import { userErrorMessage } from "./errors";
import { useMe, useMyRpc } from "./me";
import { fontSize, spacing } from "./paseo-theme";

// Whose this workspace is: its agents send chat messages, and hear replies, as that person (server/daemon.ts). The
// person at this client claims a workspace no one owns, or lets go of their own.
export function WorkspaceOwner({ colors, workspaceId }: { colors: Colors; workspaceId: string }) {
  const me = useMe();
  const read = useRpc(readWorkspaceOwner);
  const claim = useMyRpc(claimWorkspace);
  const [owner, setOwner] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setOwner((await read({ workspaceId })).owner);
    } catch (failure) {
      setError(userErrorMessage(failure));
    }
  }, [read, workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setOwner((await claim({ workspaceId, claim: next })).owner);
    } catch (failure) {
      setError(userErrorMessage(failure));
      // Someone else may have claimed it meanwhile.
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (owner === undefined) return error ? <ErrorLine colors={colors} message={error} /> : null;
  const mine = owner !== null && owner === me;
  const label = owner === null ? "Workspace này chưa có chủ: agent ở đây chưa dùng được chat."
    : mine ? "Workspace của bạn: agent ở đây nhắn thay bạn." : `Workspace của ${owner}.`;
  return <View style={{ gap: spacing[1] }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2], flexWrap: "wrap" }}>
      <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: fontSize.sm }}>{label}</Text>
      {owner === null ? <Button colors={colors} variant="ghost" icon="UserCheck" label="Nhận workspace này" disabled={busy} onPress={() => { void change(true); }} />
        : mine ? <Button colors={colors} variant="ghost" label="Bỏ nhận" disabled={busy} onPress={() => { void change(false); }} /> : null}
    </View>
    {error === null ? null : <ErrorLine colors={colors} message={error} />}
  </View>;
}
