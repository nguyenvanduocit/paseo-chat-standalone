//! Who a request is (docs/standalone.md): the broker serves the one Paseo daemon of this
//! machine. That daemon holds the broker key, `Authorization: Bearer <key>`, and names the person each client picked in
//! `X-Chat-Handle`. The key keeps out anything else that can reach the port; the handle is the client's own word.

use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::model::is_handle;

/// A shorter key is refused at start: it would be guessable by anything on the machine that can reach the port.
pub const MIN_KEY_LENGTH: usize = 16;

pub fn unauthorized() -> ApiError {
    ApiError::new(
        401,
        "unauthorized",
        "Khóa chat broker không đúng. Kiểm tra CHAT_BROKER_KEY của daemon.",
    )
}

pub struct Identity {
    key: [u8; 32],
}

impl Identity {
    pub fn new(key: &str) -> Identity {
        Identity {
            key: Sha256::digest(key.as_bytes()).into(),
        }
    }

    /// The handle behind `Authorization: Bearer <key>` and `X-Chat-Handle`.
    pub fn resolve(
        &self,
        authorization: Option<&str>,
        chat_handle: Option<&str>,
    ) -> Result<String, ApiError> {
        let presented = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or_else(unauthorized)?;
        // Compared as digests, so the time taken says nothing about how much of the key matched.
        let digest: [u8; 32] = Sha256::digest(presented.as_bytes()).into();
        let differs = digest
            .iter()
            .zip(self.key.iter())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b));
        if differs != 0 {
            return Err(unauthorized());
        }
        chat_handle
            .filter(|handle| is_handle(handle))
            .map(str::to_owned)
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "bad_handle",
                    "Thiếu X-Chat-Handle hoặc handle không hợp lệ.",
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_names_the_handle_and_anything_else_is_refused() {
        let identity = Identity::new("key-0123456789abcdef");
        let ok = identity.resolve(Some("Bearer key-0123456789abcdef"), Some("carol"));
        assert_eq!(ok.expect("the handle"), "carol");
        let wrong = identity.resolve(Some("Bearer key-0123456789abcdeX"), Some("carol"));
        assert_eq!(wrong.expect_err("refused").code(), "unauthorized");
        let missing = identity.resolve(None, Some("carol"));
        assert_eq!(missing.expect_err("refused").code(), "unauthorized");
        let unnamed = identity.resolve(Some("Bearer key-0123456789abcdef"), None);
        assert_eq!(unnamed.expect_err("refused").code(), "bad_handle");
        let malformed = identity.resolve(Some("Bearer key-0123456789abcdef"), Some("bad handle"));
        assert_eq!(malformed.expect_err("refused").code(), "bad_handle");
    }
}
