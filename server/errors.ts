export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'APP_ERROR') { super(message); }
}
export class DownloadReservationError extends AppError {
  constructor(readonly sourceBytes: number, readonly estimated = false) {
    super('Media exceeds its temporary-disk reservation. Increase max staged storage or reduce download concurrency.', 409);
  }
}
export class NasError extends AppError {
  constructor(public nasCode: number, operation: string) {
    const detail = nasCode === 403 && operation === 'login' ? 'Two-factor authentication code required.'
      : [105, 106, 107, 119].includes(nasCode) ? 'Session expired or access denied. Reconnect and check Photos permissions.'
      : nasCode === 400 && operation === 'login' ? 'Incorrect username or password.'
      : `NAS rejected ${operation} (code ${nasCode}).`;
    super(detail, [105, 106, 107, 119].includes(nasCode) ? 401 : 400, 'NAS_ERROR');
  }
}
export function errorMessage(error: unknown): string {
  // Never return Axios errors: their messages/configs can contain NAS URLs or credentials.
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'Operation cancelled or timed out.';
  const code = (error as { code?: string })?.code;
  if (code?.includes('CERT') || code?.includes('SELF_SIGNED')) return 'NAS HTTPS certificate is not trusted. Use a hostname with a trusted certificate.';
  return 'Operation failed. Check the NAS connection and local media tools.';
}
