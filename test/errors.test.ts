import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, errorMessage, NasDownloadError } from '../server/errors.ts';

test('transport diagnostics expose safe guidance without Axios request secrets', () => {
  for (const [code, message] of [
    ['ECONNRESET', /connection closed/], ['ERR_STREAM_PREMATURE_CLOSE', /connection closed/],
    ['ETIMEDOUT', /timed out/], ['ECONNABORTED', /timed out/],
    ['ENOTFOUND', /hostname could not be resolved/], ['EAI_AGAIN', /hostname could not be resolved/],
    ['ECONNREFUSED', /Cannot reach/], ['EHOSTUNREACH', /Cannot reach/], ['ENETUNREACH', /Cannot reach/],
    ['SELF_SIGNED_CERT_IN_CHAIN', /certificate is not trusted/]
  ] as const) {
    const error = Object.assign(new Error('request contained password-secret'), { code, config: { password: 'password-secret', headers: { Cookie: 'session-secret' } } });
    assert.match(errorMessage(error), message);
    assert.doesNotMatch(errorMessage(error), /password-secret|session-secret/);
  }
  assert.equal(errorMessage(new AppError('A specific tool error.')), 'A specific tool error.');
  assert.match(errorMessage(new NasDownloadError(5, 0)), /received 5 bytes/);
  assert.match(errorMessage(new DOMException('secret', 'AbortError')), /cancelled/);
  for (const error of [null, undefined, { code: 123 }, new Error('password-secret')]) {
    assert.equal(errorMessage(error), 'Operation failed. Check the NAS connection and local media tools.');
  }
});
