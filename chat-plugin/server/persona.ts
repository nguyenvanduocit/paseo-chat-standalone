import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// The person's persona: a directory of plain files on this daemon that their talk-to-myself tab reads and writes
// with Claude's own Read, Write and Edit, in whatever shape it sees fit. The router and every worker read every file in
// it. The plugin only reads the directory, to tell agents when it changed and to keep each version it saw in history,
// since the daily improvement changes it without the person watching.

export interface PersonaFile { name: string; content: string }
// The persona now: its files by name, a version that changes with any of them and with where the persona is, and when
// one was last written. The router and the workers read it by its path, so a persona that moved is a new version for them.
export interface Persona { files: PersonaFile[]; version: string; updatedAt: string | null }

// Beside the persona, the talk-to-myself tab keeps the person's decision records: what they decided, how and why. They
// are the evidence the persona's taste is drawn from, long and growing, so they are not the persona: the router and the
// workers do not read them, and changing them is not a new version.
export const decisionsDir = "decisions";

// Editor and partial-write files are not the persona.
const hidden = (name: string) => name.startsWith(".") || name.endsWith(".partial");

// `delegation` is the copy of the delegation catalog: not the person's file, but what the persona is read with, so
// its text is part of the version and a changed catalog is told to every tab like a changed persona.
export function personaStore(dir: string, historyDir: string, delegation: string) {
  async function read(): Promise<Persona> {
    const catalog = await readFile(delegation, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    let entries;
    try {
      entries = await readdir(dir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], version: versionOf(dir, [], catalog), updatedAt: null };
      throw error;
    }
    const decisions = join(dir, decisionsDir);
    const paths = entries.filter(entry => entry.isFile() && !hidden(entry.name))
      .map(entry => join(entry.parentPath, entry.name))
      .filter(path => !path.startsWith(`${decisions}/`)).sort();
    const files = await Promise.all(paths.map(async path => ({ name: relative(dir, path), content: await readFile(path, "utf8") })));
    const times = await Promise.all(paths.map(async path => (await stat(path)).mtimeMs));
    return { files, version: versionOf(dir, files, catalog), updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null };
  }

  return {
    dir,
    delegation,
    history: historyDir,
    read,
    // Keeps this version of the persona in history once: `history/persona-<version>/`, the directory as it was.
    async keep(persona: Persona) {
      if (!persona.files.length) return;
      const target = join(historyDir, `persona-${persona.version}`);
      if (await stat(target).then(() => true, () => false)) return;
      await mkdir(historyDir, { recursive: true });
      const partial = `${target}.${randomBytes(6).toString("hex")}.partial`;
      await mkdir(partial);
      await Promise.all(persona.files.map(async file => {
        await mkdir(join(partial, file.name, ".."), { recursive: true });
        await writeFile(join(partial, file.name), file.content);
      }));
      await rename(partial, target).catch(async error => {
        await rm(partial, { recursive: true, force: true });
        // Another tick kept the same version first.
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    },
  };
}

export type PersonaStore = ReturnType<typeof personaStore>;

const versionOf = (dir: string, files: PersonaFile[], catalog: string) =>
  createHash("sha256").update(JSON.stringify({ dir, files, catalog })).digest("hex").slice(0, 16);
