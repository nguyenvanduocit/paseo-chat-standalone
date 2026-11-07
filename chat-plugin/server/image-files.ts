import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { imageIdPattern, maxImageBytes, type ChatMessageView } from "../shared/chat";
import type { ChatClient } from "./chat";

// Chat images as agents handle them: files on this host. Paseo's agent tools answer in text only, so an agent sees a
// chat image by reading the file `chat_image` saves, and sends one by naming an image file it has. The chat broker
// checks what is sent (chat-broker/src/chat.rs, `upload`); nothing here decides what counts as an image.

const extensionOf: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

// Where saved images go. A file is named by its image id, the SHA-256 of its bytes, so saving one twice writes it once.
export const chatImageDir = (home = homedir()) => join(home, ".paseo", "chat-images");

// How a message's images read in text for agents: their ids, which `chat_image` takes.
export const imageIdsLine = (message: Pick<ChatMessageView, "attachments">) =>
  message.attachments.length ? `[images: ${message.attachments.map(attachment => attachment.id).join(", ")} — view with chat_image]` : "";

// Saves the chat image `id` to `dir` and returns the file's path.
export async function saveChatImage(chat: ChatClient, dir: string, id: string): Promise<string> {
  if (!imageIdPattern.test(id)) throw new Error(`"${id}" is not a chat image id: they are 64 hex characters, listed after [images: in chat_read.`);
  const { mime, bytes } = await chat.image(id);
  const extension = extensionOf[mime];
  if (!extension) throw new Error(`Chat image ${id} has an unknown type ${mime}.`);
  const path = join(dir, `${id}.${extension}`);
  if (await stat(path).then(() => true, () => false)) return path;
  await mkdir(dir, { recursive: true });
  // Written beside the final name, then renamed: a reader never sees half a file.
  const partial = `${path}.${randomBytes(4).toString("hex")}.part`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return path;
}

// Uploads the image files an agent names and returns their attachment ids, in order.
export async function uploadImageFiles(chat: ChatClient, paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Image path "${path}" must be absolute.`);
    const size = (await stat(path)).size;
    if (size > maxImageBytes) throw new Error(`${path} is larger than ${maxImageBytes / 1024 / 1024} MB.`);
    ids.push((await chat.upload((await readFile(path)).toString("base64"))).attachment.id);
  }
  return ids;
}
