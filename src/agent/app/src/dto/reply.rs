use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Reply<T> {
    status: u16,
    content: Option<T>,
    message: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("server error: {status}\t{message}")]
pub struct ReplyError {
    pub status: u16,
    pub message: String,
}

impl<T> Reply<T> {
    #[inline]
    pub const fn status(&self) -> u16 {
        self.status
    }

    /// Get the replied data.
    ///
    /// # Panic
    ///
    /// Panic when the `content` field is null or undeined.
    #[inline]
    pub fn content(self) -> T {
        self.content.unwrap()
    }

    /// Cosume Reply and return its error form.
    ///
    /// # Panic
    ///
    /// Panic when the `status` is `OK` or the `message` field is *null/undeined*.
    #[inline]
    pub fn error(self) -> ReplyError {
        assert!(!self.is_ok());
        ReplyError {
            status: self.status,
            message: self.message.unwrap(),
        }
    }

    #[inline]
    pub const fn is_ok(&self) -> bool {
        self.status == 200
    }

    #[inline]
    pub const fn token_expired(&self) -> bool {
        self.status == 400
    }
}
