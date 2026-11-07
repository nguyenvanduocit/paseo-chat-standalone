import { type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMyRpc } from "./me";
import { useState } from "react";
import { openChatTab, parseConversationId } from "../shared/chat";
import { userErrorMessage } from "./errors";

// Opens a conversation in a Paseo agent tab, where Paseo's own composer and timeline show it: from the Chat screen and
// from the Cần lưu ý screen. `opening` is the conversation on its way, `error` why the last one did not open.
export function useOpenConversation(navigation: PluginScreenProps["navigation"]) {
  const openTab = useMyRpc(openChatTab);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function open(id: string) {
    const conversation = parseConversationId(id);
    if (!conversation) { setError("Không mở được cuộc trò chuyện này."); return; }
    if (!navigation) { setError("Bản Paseo này chưa mở được tab từ plugin."); return; }
    setOpening(id);
    setError(null);
    try {
      navigation.openAgent({ agentId: (await openTab({ conversation })).agentId });
    } catch (failure) {
      setError(userErrorMessage(failure));
    } finally {
      setOpening(null);
    }
  }
  return { open, opening, error };
}
