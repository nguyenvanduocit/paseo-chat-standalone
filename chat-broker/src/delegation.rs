//! The team's delegation catalog: which kinds of work an AI settles for a person and which only the person
//! decides. The catalog is `delegation.md`, compiled in, so it changes only through a commit and a broker deploy.
//! Pure: the classifier names the kind of decision a message makes; `breach` checks it against the catalog and the
//! conversation.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::model::{Message, is_message_key};

pub const TEXT: &str = include_str!("../delegation.md");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    /// The AI settles it.
    Ai,
    /// The AI settles it and leaves a line on the person's attention list.
    AiReport,
    /// Only the person decides; no persona changes that.
    Human,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Category {
    pub id: String,
    pub work: String,
    pub level: Level,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Catalog {
    pub version: String,
    pub categories: Vec<Category>,
    pub text: String,
}

/// A table row: | `id` | work | level |
static ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\|\s*`([a-z][a-z0-9.-]*)`\s*\|\s*(.+?)\s*\|\s*(ai|ai-report|human)\s*\|\s*$")
        .expect("the catalog row pattern compiles")
});

/// "Decided by <handle>: <message-key>" on a line of its own; the key may sit in backticks.
static DECIDED_BY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?m)^[\s>*_]*Decided by\s+@?([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*:\s*`?([^`\s]+)`?\s*$",
    )
    .expect("the decided-by pattern compiles")
});

impl Catalog {
    /// The catalog in `text`: every table row with an id, the work and a level. Ids are unique.
    pub fn parse(text: &str) -> Result<Catalog, String> {
        let mut categories: Vec<Category> = Vec::new();
        for line in text.lines() {
            let Some(row) = ROW.captures(line.trim()) else {
                continue;
            };
            let level = match &row[3] {
                "ai" => Level::Ai,
                "ai-report" => Level::AiReport,
                _ => Level::Human,
            };
            if categories.iter().any(|category| category.id == row[1]) {
                return Err(format!("the catalog names {} twice", &row[1]));
            }
            categories.push(Category {
                id: row[1].to_owned(),
                work: row[2].to_owned(),
                level,
            });
        }
        if categories.is_empty() {
            return Err("the catalog has no category".to_owned());
        }
        let version = hex::encode(Sha256::digest(text.as_bytes()))[..16].to_owned();
        Ok(Catalog {
            version,
            categories,
            text: text.to_owned(),
        })
    }

    pub fn level(&self, id: &str) -> Option<Level> {
        self.categories
            .iter()
            .find(|category| category.id == id)
            .map(|category| category.level)
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.categories.iter().map(|category| category.id.as_str())
    }
}

/// The catalog this broker was built with.
pub static CATALOG: LazyLock<Catalog> =
    LazyLock::new(|| Catalog::parse(TEXT).expect("delegation.md is a valid catalog"));

/// Who the message says decided, and the key of the message where they did.
pub fn decided_by(body: &str) -> Option<(String, String)> {
    let found = DECIDED_BY.captures_iter(body).last()?;
    Some((found[1].to_owned(), found[2].to_owned()))
}

/// True when an AI-sent `message` makes a decision of a `human` kind (`decision`, as the classifier named it) without
/// pointing at an earlier message in which the named person, typing it themselves, decided. `find` looks a key up in
/// the message's conversation.
pub fn breach<'a>(
    catalog: &Catalog,
    message: &Message,
    decision: Option<&str>,
    find: impl Fn(&str) -> Option<&'a Message>,
) -> bool {
    if message.via.is_none() {
        return false;
    }
    if decision.and_then(|id| catalog.level(id)) != Some(Level::Human) {
        return false;
    }
    let Some((handle, key)) = decided_by(&message.body) else {
        return true;
    };
    if !is_message_key(&key) || key.as_str() >= message.key.as_str() {
        return true;
    }
    !find(&key).is_some_and(|decided| decided.author == handle && decided.via.is_none())
}
