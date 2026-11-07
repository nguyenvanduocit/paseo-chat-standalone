//! What a request can fail with: a refusal the caller reads as `{error, message}`, or an internal fault.

#[derive(Debug, PartialEq, Eq)]
pub enum ApiError {
    /// Answered as `{"error": code, "message": message}` with `status`. `message` is Vietnamese: the plugin shows it.
    Refused {
        status: u16,
        code: &'static str,
        message: String,
    },
    /// Answered as 500 `{"error": "internal"}`; the reason goes to the log only.
    Internal(String),
}

impl ApiError {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> ApiError {
        ApiError::Refused {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(400, "bad_request", message)
    }

    pub fn io(what: &str, error: &std::io::Error) -> ApiError {
        ApiError::Internal(format!("{what} could not be written ({})", error.kind()))
    }

    /// The refusal's code; `internal` for a fault.
    pub fn code(&self) -> &'static str {
        match self {
            ApiError::Refused { code, .. } => code,
            ApiError::Internal(_) => "internal",
        }
    }
}
