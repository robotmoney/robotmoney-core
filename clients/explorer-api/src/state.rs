// Shared HTTP-handler state. Holds the Postgres pool used by every read-only
// endpoint defined in `routes`.

use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
}

impl AppState {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}
