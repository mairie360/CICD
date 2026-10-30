async function examples(redis: Redis, client: RedisClient, cache: Map<string, string>, value: string) {
  // ruleid: gdpr-ts-redis-write-without-ttl
  await redis.set('key', value);
  // ruleid: gdpr-ts-redis-write-without-ttl
  await client.set('key', value, { NX: true });
  // ruleid: gdpr-ts-redis-write-without-ttl
  await redis.hset('hash', 'field', value);
  // ruleid: gdpr-ts-redis-write-without-ttl
  await client.mSet(['a', '1', 'b', '2']);
  // ok: gdpr-ts-redis-write-without-ttl
  await redis.set('key', value, 'EX', 60);
  // ok: gdpr-ts-redis-write-without-ttl
  await client.set('key', value, { EX: 60, NX: true });
  // ok: gdpr-ts-redis-write-without-ttl
  await redis.setex('key', 60, value);
  // ok: gdpr-ts-redis-write-without-ttl
  cache.set('key', value);
}
