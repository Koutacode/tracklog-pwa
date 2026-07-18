export function isPermanentDriverAuthFailure(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = (
    typeof record?.code === 'string'
      ? record.code
      : typeof record?.error_code === 'string'
        ? record.error_code
        : ''
  ).trim().toLowerCase();
  if (
    code === 'refresh_token_already_used'
    || code === 'refresh_token_not_found'
    || code === 'session_not_found'
    || code === 'user_not_found'
  ) {
    return true;
  }
  const text = error instanceof Error ? error.message.trim().toLowerCase() : '';
  if (!text) return false;
  return text.includes('refresh_token_not_found')
    || text.includes('refresh token not found')
    || text.includes('refresh_token_already_used')
    || text.includes('refresh token already used')
    || text.includes('invalid refresh token: already used')
    || text.includes('invalid refresh token')
    || text.includes('session not found')
    || text.includes('user not found');
}
