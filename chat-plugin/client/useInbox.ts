import { useMe, useMyRpc } from "./me";
import { useEffect, useState } from "react";
import { readChatInbox, type ChatInbox } from "../shared/chat";
import { userErrorMessage } from "./errors";
import { watchInput } from "./input-activity";

const pollIntervalMs = 3_000;

// The person's conversations, unread counts, people and open requests, refreshed every few seconds. Each poll also
// says how long ago this window had input, which is how others see the person as active or AFK.
export function useInbox() {
  const read = useMyRpc(readChatInbox);
  const me = useMe();
  const [inbox, setInbox] = useState<ChatInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Nothing to read until a person is picked at this client; another person's inbox starts empty.
    setInbox(null);
    if (me === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const input = watchInput();
    async function poll() {
      try {
        const next = await read({ idleMs: input.idleMs() });
        if (!cancelled) { setInbox(next); setError(null); }
      } catch (failure) {
        if (!cancelled) setError(userErrorMessage(failure));
      } finally {
        if (!cancelled) timer = setTimeout(poll, pollIntervalMs);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); input.stop(); };
  }, [read, me]);
  return { inbox, error };
}
