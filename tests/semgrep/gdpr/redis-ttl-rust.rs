async fn examples(conn: &mut Connection, redis: &Redis, value: &str) {
    // ruleid: gdpr-rust-redis-write-without-ttl
    conn.set::<_, _, ()>("key", value).await.unwrap();
    // ruleid: gdpr-rust-redis-write-without-ttl
    let _: () = redis::cmd("SET").arg("key").arg(value).query_async(conn).await.unwrap();
    // ruleid: gdpr-rust-redis-write-without-ttl
    connection.hset("hash", "field", value).await.unwrap();
    // ok: gdpr-rust-redis-write-without-ttl
    let _: () = redis::cmd("SET").arg("key").arg(value).arg("EX").arg(60).query_async(conn).await.unwrap();
    // ok: gdpr-rust-redis-write-without-ttl
    conn.set_ex::<_, _, ()>("key", value, 60).await.unwrap();
    // ok: gdpr-rust-redis-write-without-ttl
    redis.set_ex("key", value, 60).await.unwrap();
    // ok: gdpr-rust-redis-write-without-ttl
    ADMIN_ID.set(1).ok();
}
