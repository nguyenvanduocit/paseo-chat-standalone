//! The chat directory on disk. The layout is the one the plugin wrote before the broker, so old data loads as is
//! and a host can still read it with a shell:
//!
//! ```text
//! threads/<h(project)>/project.json                 { project }
//! threads/<h(project)>/<h(room)>/room.json          { project, room }
//! dms/<h(members joined by ",")>/conversation.json  { members }
//! <conversation>/messages/<key>.json                Message, written once
//! <conversation>/classifications/<key>.json         Classification of that message, written once after it
//! <conversation>/reads/<handle>.json                { key }
//! <conversation>/invited/<handle>.json              { by, at }
//! people/<handle>.json                              { at, activeAt, projects }   (ms)
//! agents/<handle>.json                              { at, running }
//! focus/<handle>.json                               { conversation, at }
//! images/<sha256>, images/<sha256>.json             image bytes, then metadata
//! assistant/<handle>.json                           AssistantState
//! watches/<handle>.json                             [Watch]   the agents of that handle's host waiting on replies
//! signals/<alert>.json                              SignalFile
//! ```
//!
//! `h(x)` is the first 32 hex characters of SHA-256 of `x`. Every write goes to `<path>.<6 random bytes hex>.partial`
//! and is renamed over `<path>`, so a reader never sees half a file. Loading skips, with a log line, every file that is
//! not what its place says and every `.partial` file.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::classify::Classification;
use crate::log::Log;
use crate::model::{
    Conversation, Message, is_cursor, is_handle, is_image_id, is_message_key, is_name_key,
};
use crate::signals::{self, SignalFile};
use crate::state::{AgentsFile, AssistantState, Focus, ImageMeta, PersonFile, State, Thread};
use crate::watches;

fn random_hex(count: usize) -> String {
    let mut buffer = vec![0; count];
    getrandom::fill(&mut buffer).expect("the operating system has no random source");
    hex::encode(buffer)
}

/// Writes under the chat root.
pub struct Files {
    root: PathBuf,
}

impl Files {
    pub fn new(root: impl Into<PathBuf>) -> Files {
        Files { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Publish `bytes` at `relative`: a partial file beside it, flushed, then renamed over it.
    pub fn write(&self, relative: &str, bytes: &[u8]) -> io::Result<()> {
        let target = self.root.join(relative);
        let directory = target.parent().unwrap_or(&self.root);
        fs::create_dir_all(directory)?;
        let file_name = target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let partial = directory.join(format!("{file_name}.{}.partial", random_hex(6)));
        let written = (|| {
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&partial)?;
            output.write_all(bytes)?;
            output.sync_all()?;
            fs::rename(&partial, &target)
        })();
        if written.is_err() {
            let _ = fs::remove_file(&partial);
        }
        written
    }

    pub fn write_json(&self, relative: &str, value: &Value) -> io::Result<()> {
        self.write(relative, value.to_string().as_bytes())
    }

    /// Delete the file at `relative`; one already gone is not an error.
    pub fn remove(&self, relative: &str) -> io::Result<()> {
        match fs::remove_file(self.root.join(relative)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }

    pub fn exists(&self, relative: &str) -> bool {
        self.root.join(relative).exists()
    }

    pub fn read(&self, relative: &str) -> io::Result<Vec<u8>> {
        fs::read(self.root.join(relative))
    }

    /// Writes the files that name a conversation, those still missing: `project.json` and `room.json` for a room,
    /// `conversation.json` for a direct message.
    pub fn create_conversation(&self, conversation: &Conversation) -> io::Result<()> {
        let dir = conversation.dir();
        match conversation {
            Conversation::Dm { members } => {
                let path = format!("{dir}/conversation.json");
                if !self.exists(&path) {
                    self.write_json(&path, &json!({ "members": members }))?;
                }
            }
            Conversation::Room { project, room } => {
                let project_path = format!("{}/project.json", parent(&dir));
                if !self.exists(&project_path) {
                    self.write_json(&project_path, &json!({ "project": project }))?;
                }
                let path = format!("{dir}/room.json");
                if !self.exists(&path) {
                    self.write_json(&path, &json!({ "project": project, "room": room }))?;
                }
            }
        }
        Ok(())
    }
}

fn parent(relative: &str) -> &str {
    relative.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// Names in a directory, sorted; none when it does not exist.
fn names(dir: &Path) -> io::Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut names = Vec::new();
    for entry in entries {
        names.push(entry?.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    Ok(names)
}

/// A file's JSON; None (with a log line) when it is missing or not JSON.
fn read_json(path: &Path, log: &Log) -> io::Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                log.warning(format!("skipping {}: not JSON", path.display()));
                Ok(None)
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// The `<handle>.json` files of a directory, as (handle, JSON). Other names and unreadable files are skipped.
fn handle_files(dir: &Path, log: &Log) -> io::Result<Vec<(String, Value)>> {
    let mut files = Vec::new();
    for name in names(dir)? {
        let handle = name
            .strip_suffix(".json")
            .filter(|handle| is_handle(handle));
        let Some(handle) = handle else {
            log.warning(format!(
                "skipping {}: not <handle>.json",
                dir.join(&name).display()
            ));
            continue;
        };
        if let Some(value) = read_json(&dir.join(&name), log)? {
            files.push((handle.to_owned(), value));
        }
    }
    Ok(files)
}

fn number(value: &Value, field: &str) -> Option<i64> {
    let number = value.get(field)?;
    number.as_i64().or_else(|| {
        number
            .as_f64()
            .filter(|n| n.is_finite())
            .map(|n| n.trunc() as i64)
    })
}

fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn skip(log: &Log, path: &Path, why: &str) {
    log.warning(format!("skipping {}: {why}", path.display()));
}

fn load_thread(root: &Path, conversation: Conversation, log: &Log) -> io::Result<Thread> {
    let dir = root.join(conversation.dir());
    let mut thread = Thread::new(conversation);
    let messages = dir.join("messages");
    for name in names(&messages)? {
        let path = messages.join(&name);
        let Some(key) = name.strip_suffix(".json").filter(|key| is_message_key(key)) else {
            skip(log, &path, "not <key>.json");
            continue;
        };
        match read_json(&path, log)?.and_then(Message::parse) {
            Some(message) if message.key == key => thread.load(message),
            Some(_) => skip(log, &path, "its key is not its file name"),
            None => skip(log, &path, "not a message"),
        }
    }
    thread.reindex();
    let classifications = dir.join("classifications");
    for name in names(&classifications)? {
        let path = classifications.join(&name);
        let Some(key) = name
            .strip_suffix(".json")
            .filter(|key| thread.messages.contains_key(*key))
        else {
            skip(log, &path, "not <key of a message>.json");
            continue;
        };
        match read_json(&path, log)?.map(serde_json::from_value::<Classification>) {
            Some(Ok(classification)) => {
                thread
                    .classifications
                    .insert(key.to_owned(), classification);
            }
            Some(Err(_)) => skip(log, &path, "not a classification"),
            None => {}
        }
    }
    for (handle, value) in handle_files(&dir.join("reads"), log)? {
        match text(&value, "key").filter(|key| is_cursor(key)) {
            Some(key) => {
                thread.reads.insert(handle, key.to_owned());
            }
            None => skip(
                log,
                &dir.join("reads").join(format!("{handle}.json")),
                "not { key }",
            ),
        }
    }
    for (handle, value) in handle_files(&dir.join("invited"), log)? {
        if value.is_object() {
            thread.invited.insert(handle);
        }
    }
    Ok(thread)
}

fn load_rooms(root: &Path, state: &mut State, log: &Log) -> io::Result<()> {
    let threads = root.join("threads");
    for project_key in names(&threads)? {
        let project_dir = threads.join(&project_key);
        if !is_name_key(&project_key) || !project_dir.is_dir() {
            skip(log, &project_dir, "not a project directory");
            continue;
        }
        for room_key in names(&project_dir)? {
            let dir = project_dir.join(&room_key);
            if room_key == "project.json" {
                continue;
            }
            if !is_name_key(&room_key) || !dir.is_dir() {
                skip(log, &dir, "not a room directory");
                continue;
            }
            let room = read_json(&dir.join("room.json"), log)?.and_then(|value| {
                Conversation::room(text(&value, "project")?, text(&value, "room")?)
            });
            match room {
                Some(room) if room.dir() == format!("threads/{project_key}/{room_key}") => {
                    let thread = load_thread(root, room, log)?;
                    state.threads.insert(thread.conversation.id(), thread);
                }
                Some(_) => skip(log, &dir, "its name is not h(project)/h(room)"),
                None => skip(log, &dir, "no valid room.json"),
            }
        }
    }
    Ok(())
}

fn load_dms(root: &Path, state: &mut State, log: &Log) -> io::Result<()> {
    let dms = root.join("dms");
    for name in names(&dms)? {
        let dir = dms.join(&name);
        let dm = read_json(&dir.join("conversation.json"), log)?.and_then(|value| {
            let members: Vec<String> = value
                .get("members")?
                .as_array()?
                .iter()
                .map(|member| member.as_str().map(str::to_owned))
                .collect::<Option<_>>()?;
            Conversation::dm(&members)
        });
        match dm {
            Some(dm) if dm.dir() == format!("dms/{name}") => {
                let thread = load_thread(root, dm, log)?;
                state.threads.insert(thread.conversation.id(), thread);
            }
            Some(_) => skip(log, &dir, "its name is not h(members)"),
            None => skip(log, &dir, "no valid conversation.json"),
        }
    }
    Ok(())
}

fn load_images(root: &Path, state: &mut State, log: &Log) -> io::Result<()> {
    let images = root.join("images");
    for name in names(&images)? {
        let path = images.join(&name);
        if is_image_id(&name) {
            state.image_bytes += fs::metadata(&path)?.len();
        } else if let Some(id) = name.strip_suffix(".json").filter(|id| is_image_id(id)) {
            match read_json(&path, log)?
                .and_then(|value| serde_json::from_value::<ImageMeta>(value).ok())
            {
                Some(meta) => {
                    state.images.insert(id.to_owned(), meta);
                }
                None => skip(log, &path, "not image metadata"),
            }
        } else {
            skip(log, &path, "not an image file");
        }
    }
    Ok(())
}

fn load_signals(root: &Path, state: &mut State, log: &Log) -> io::Result<()> {
    let dir = root.join("signals");
    for name in names(&dir)? {
        let path = dir.join(&name);
        let Some(alert) = name
            .strip_suffix(".json")
            .filter(|alert| signals::is_alert(alert))
        else {
            skip(log, &path, "not <alert>.json");
            continue;
        };
        match read_json(&path, log)?.and_then(SignalFile::parse) {
            Some(file) if file.alert == alert => {
                state.signals.insert(file.alert.clone(), file);
            }
            Some(_) => skip(log, &path, "its alert is not its file name"),
            None => skip(log, &path, "not a signal"),
        }
    }
    Ok(())
}

/// Everything under `root`, as the state the broker serves from.
pub fn load(root: &Path, log: &Log) -> io::Result<State> {
    let mut state = State::default();
    load_rooms(root, &mut state, log)?;
    load_dms(root, &mut state, log)?;
    for (handle, value) in handle_files(&root.join("people"), log)? {
        if !value.is_object() {
            skip(
                log,
                &root.join("people").join(format!("{handle}.json")),
                "not an object",
            );
            continue;
        }
        let projects = value
            .get("projects")
            .and_then(Value::as_array)
            .map(|projects| {
                projects
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        state.people.insert(
            handle,
            PersonFile {
                at: number(&value, "at").unwrap_or(0),
                active_at: number(&value, "activeAt").unwrap_or(0),
                projects,
            },
        );
    }
    for (handle, value) in handle_files(&root.join("agents"), log)? {
        if !value.is_object() {
            skip(
                log,
                &root.join("agents").join(format!("{handle}.json")),
                "not an object",
            );
            continue;
        }
        let running = value.get("running").and_then(Value::as_i64);
        state.agents.insert(
            handle,
            AgentsFile {
                at: number(&value, "at").unwrap_or(0),
                running,
            },
        );
    }
    for (handle, value) in handle_files(&root.join("focus"), log)? {
        match serde_json::from_value::<Focus>(value) {
            Ok(focus) => {
                state.focus.insert(handle, focus);
            }
            Err(_) => skip(
                log,
                &root.join("focus").join(format!("{handle}.json")),
                "not { conversation, at }",
            ),
        }
    }
    for (handle, value) in handle_files(&root.join("assistant"), log)? {
        match AssistantState::parse(value) {
            Some(assistant) => {
                state.assistant.insert(handle, assistant);
            }
            None => skip(
                log,
                &root.join("assistant").join(format!("{handle}.json")),
                "not an assistant state",
            ),
        }
    }
    for (handle, value) in handle_files(&root.join("watches"), log)? {
        match watches::parse(value) {
            Some(list) => {
                state.watches.insert(handle, list);
            }
            None => skip(
                log,
                &root.join("watches").join(format!("{handle}.json")),
                "not a list of watches",
            ),
        }
    }
    load_signals(root, &mut state, log)?;
    load_images(root, &mut state, log)?;
    Ok(state)
}
