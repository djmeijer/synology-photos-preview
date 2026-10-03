export class AppError extends Error {
  constructor(message: string, public status = 400, public code = 'APP_ERROR') { super(message); }
}
export class DownloadReservationError extends AppError {
  constructor(readonly sourceBytes: number, readonly estimated = false) {
    super('Media exceeds its temporary-disk reservation. Increase max staged storage or reduce download concurrency.', 409);
  }
}
export class NasDownloadError extends AppError {
  constructor(readonly receivedBytes: number, readonly expectedBytes: number) {
    const amount = expectedBytes > 0 ? `${receivedBytes} of ${expectedBytes} bytes` : `${receivedBytes} bytes`;
    super(`NAS original-media download was incomplete (received ${amount}). Check that the original downloads completely in Synology Photos, then retry.`, 502, 'NAS_DOWNLOAD_ERROR');
  }
}
export class NasError extends AppError {
  constructor(public nasCode: number, operation: string) {
    const detail = nasCode === 403 && operation === 'login' ? 'Two-factor authentication code required.'
      : [105, 106, 107, 119].includes(nasCode) ? 'Session expired or access denied. Reconnect and check Photos permissions.'
      : nasCode === 400 && operation === 'login' ? 'Incorrect username or password.'
      : nasCode === 108 && operation === 'preview upload' ? 'NAS rejected preview upload (code 108: file upload failed). This code does not identify the cause.'
      : `NAS rejected ${operation} (code ${nasCode}).`;
    super(detail, [105, 106, 107, 119].includes(nasCode) ? 401 : 400, 'NAS_ERROR');
  }
}
export function errorMessage(error: unknown): string {
  // Never return Axios errors: their messages/configs can contain NAS URLs or credentials.
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'Operation cancelled or timed out.';
  const rawCode = (error as { code?: unknown })?.code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (code?.includes('CERT') || code?.includes('SELF_SIGNED')) return 'NAS HTTPS certificate is not trusted. Use a hostname with a trusted certificate.';
  if (['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return 'NAS connection closed before the operation finished. Check the NAS connection and retry.';
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(code)) return 'NAS request timed out. Check the NAS connection and retry.';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'NAS hostname could not be resolved. Check the NAS address and network connection.';
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'Cannot reach the NAS. Check its address, port, and network connection.';
  return 'Operation failed. Check the NAS connection and local media tools.';
}
