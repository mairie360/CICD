fn examples(e: Error, user: User, email: &str, token: &str, user_id: i32) {
    // ruleid: gdpr-rust-log-personal-value
    tracing::error!("Keycloak sync failed for {}: {e}", user.email());
    // ruleid: gdpr-rust-log-personal-value
    tracing::warn!("password reset for {email}");
    // ruleid: gdpr-rust-log-personal-value
    tracing::info!(email = %user.email, "login");
    // ruleid: gdpr-rust-log-personal-value
    error!("bad token: {:?}", token);
    // ruleid: gdpr-rust-log-personal-value
    println!("{}", user.refresh_token);
    // ok: gdpr-rust-log-personal-value
    tracing::error!("Login failed: invalid credentials for user {user_id}");
    // ok: gdpr-rust-log-personal-value
    tracing::error!("Email Build Error: {e}");
    // ok: gdpr-rust-log-personal-value
    tracing::warn!("Could not delete the first-connection token: {error:?}");
    // ok: gdpr-rust-log-personal-value
    tracing::error!("Keycloak token endpoint answered {status}");
}
