function examples(req: Request, user: User, email: string, error: Error, logger: Logger) {
  // ruleid: gdpr-ts-log-personal-value
  console.log(req.body);
  // ruleid: gdpr-ts-log-personal-value
  console.error('login failed', email);
  // ruleid: gdpr-ts-log-personal-value
  logger.warn(`reset for ${user.email}`);
  // ruleid: gdpr-ts-log-personal-value
  console.warn('refresh', { status: 401, refreshToken });
  // ruleid: gdpr-ts-log-personal-value
  logger.info(user.accessToken);
  // ok: gdpr-ts-log-personal-value
  console.warn('[BFF Auth] Session revocation failed on logout', { status: 401 });
  // ok: gdpr-ts-log-personal-value
  console.error('Invalid token');
  // ok: gdpr-ts-log-personal-value
  console.error(describeError(error));
  // ok: gdpr-ts-log-personal-value
  logger.info(`user ${user.id} logged in`);
  // ruleid: gdpr-ts-log-personal-value
  console.log(`token ${token}`);
}
