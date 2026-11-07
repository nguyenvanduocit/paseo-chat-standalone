// Case- and accent-insensitive form of Vietnamese text. Unicode decomposition strips tone
// marks, but đ is its own letter rather than d plus a mark, so it is mapped by hand.
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
}
