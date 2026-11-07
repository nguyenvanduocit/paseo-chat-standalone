//! Message text: who a body mentions, and the accent-folded words search matches on. Ported from
//! `chat-plugin/shared/chat.ts` (`bodyParts`, `mentionsIn`) and `chat-plugin/shared/fold.ts`.

use std::sync::LazyLock;

use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// Code spans are text; an agent mention `@[title](agent:id)` is not a person; a person is `@handle` not glued to a
/// handle character before it. The same expression as the plugin's `bodyTokens`.
static BODY_TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(```[\s\S]*?```|`[^`\n]*`)|@\[([^\]\n]{1,200})\]\(agent:([A-Za-z0-9_-]{1,128})\)|(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})")
        .expect("the body grammar compiles")
});
static MARKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{M}").expect("the mark class compiles"));
static WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").expect("the word class compiles"));

/// The handles a body mentions, first mention first, each once. A trailing dot ends a sentence, not the handle.
pub fn mentions_in(body: &str) -> Vec<String> {
    let mut handles: Vec<String> = Vec::new();
    for captures in BODY_TOKENS.captures_iter(body) {
        let Some(handle) = captures.get(5) else {
            continue;
        };
        let name = handle.as_str().trim_end_matches('.');
        if !handles.iter().any(|known| known == name) {
            handles.push(name.to_owned());
        }
    }
    handles
}

/// The ids of the Paseo agents a body mentions (`@[title](agent:<id>)`), first mention first, each once.
pub fn agent_mentions_in(body: &str) -> Vec<String> {
    let mut agents: Vec<String> = Vec::new();
    for captures in BODY_TOKENS.captures_iter(body) {
        if let Some(id) = captures.get(3)
            && !agents.iter().any(|known| known == id.as_str())
        {
            agents.push(id.as_str().to_owned());
        }
    }
    agents
}

/// Case- and accent-insensitive form of Vietnamese text. Decomposition strips tone marks, but đ is its own letter
/// rather than d plus a mark, so it is mapped by hand.
pub fn fold(text: &str) -> String {
    let decomposed: String = text.nfd().collect();
    MARKS
        .replace_all(&decomposed, "")
        .replace(['đ', 'Đ'], "d")
        .to_lowercase()
}

/// The folded words of a text: runs of letters and numbers.
pub fn words(text: &str) -> Vec<String> {
    WORDS
        .find_iter(&fold(text))
        .map(|word| word.as_str().to_owned())
        .collect()
}

/// Every query word starts some word of the body. A query without words matches nothing.
pub fn matches(query_words: &[String], body: &str) -> bool {
    if query_words.is_empty() {
        return false;
    }
    let have = words(body);
    query_words
        .iter()
        .all(|wanted| have.iter().any(|word| word.starts_with(wanted.as_str())))
}

/// A text's length as JavaScript counts it (UTF-16 code units), so limits agree with the plugin's.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Whether JavaScript's `trim()` leaves nothing: white space, line terminators and the BOM.
pub fn is_blank(text: &str) -> bool {
    text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}
