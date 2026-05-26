// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
// Structured error responses. Every failure path returns a small JSON body
// `{ "error": "<code>", "message": "<human>" }` plus the right HTTP status.
// No raw SQL errors are leaked to clients (security boundary §11).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("database error")]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            ApiError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "resource not found".into(),
            ),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m.clone()),
            ApiError::Database(err) => {
                tracing::error!(error = %err, "database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "internal error".into(),
                )
            }
        };
        let body = Json(json!({ "error": code, "message": message }));
        (status, body).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
