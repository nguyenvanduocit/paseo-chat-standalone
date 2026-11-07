import type { PluginRpcContract } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useSyncExternalStore } from "react";
import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";

// The person at this client (docs/standalone.md). One daemon serves several people, and only the client knows which of
// them is at it, so the client picks once and names that person in every call (`as`). It is kept in the window's
// localStorage where there is one (web and desktop). The mobile app gives plugins no storage that outlives it, so there
// the person is the one whose handle is the label of the app's connection to this daemon (`hostLabelPerson`).

const storageKey = "paseo-chat.as";

interface KeyValueStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage ?? null;

let me: string | null = storage?.getItem(storageKey) ?? null;
// The host label is read once per run: after "Đổi người" the picker stays, even where the label names someone.
let labelRead = me !== null;
const listeners = new Set<() => void>();

export const currentMe = () => me;

export function setMe(handle: string | null) {
  me = handle;
  labelRead = true;
  if (handle === null) storage?.removeItem(storageKey);
  else storage?.setItem(storageKey, handle);
  for (const listener of listeners) listener();
}

// The one person of this daemon whose handle a configured host is labelled with; null when none is, or several
// different ones are, since the plugin cannot tell which host it is connected through.
export function hostLabelPerson(labels: readonly string[], people: readonly string[]): string | null {
  const named = new Set(labels.map(label => label.trim()).filter(label => people.includes(label)));
  return named.size === 1 ? [...named][0] : null;
}

// Takes the person a host label names, the first time this run asks and no one is picked yet.
export function adoptHostLabel(labels: readonly string[], people: readonly string[]) {
  if (labelRead) return;
  labelRead = true;
  const person = hostLabelPerson(labels, people);
  if (person !== null) setMe(person);
}

export function subscribeMe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const useMe = () => useSyncExternalStore(subscribeMe, currentMe);

const notPicked = () => new Error("Chưa chọn bạn là ai trên client này: mở Chat và chọn tên.");

// What a call for the person takes: its input without `as`, which this client adds.
export type MyInput<InputSchema extends ZodType> = Omit<ZodInput<InputSchema>, "as">;

// `useRpc` for a call made for the person at this client.
export function useMyRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(contract: PluginRpcContract<InputSchema, OutputSchema>) {
  const call = useRpc(contract);
  const as = useMe();
  return useCallback((input: MyInput<InputSchema>): Promise<ZodOutput<OutputSchema>> =>
    as === null ? Promise.reject(notPicked()) : call({ ...input, as } as ZodInput<InputSchema>), [call, as]);
}

// The same outside React: `client.rpc` with the person at this client.
export function myRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  rpc: (contract: PluginRpcContract<InputSchema, OutputSchema>, input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>>,
  contract: PluginRpcContract<InputSchema, OutputSchema>,
  input: MyInput<InputSchema>,
): Promise<ZodOutput<OutputSchema>> {
  const as = me;
  return as === null ? Promise.reject(notPicked()) : rpc(contract, { ...input, as } as ZodInput<InputSchema>);
}
