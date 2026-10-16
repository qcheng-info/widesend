import { describe, expect, it } from 'vitest';
import { publicError } from '../../src/messages';

describe('public error messages', () => {
  it('keeps useful recovery guidance', () => {
    expect(publicError(new Error('This code expired. Start a new transfer.'))).toContain('expired');
    expect(publicError(new DOMException('Internal quota details', 'QuotaExceededError'))).toContain(
      'Free up space',
    );
    expect(
      publicError(
        new Error(
          'This browser is blocking local disk storage. Use a regular (non-private) window and allow site storage.',
        ),
      ),
    ).toContain('regular (non-private) window');
  });

  it('does not expose arbitrary browser or peer errors', () => {
    for (const error of [new Error('Internal URL: /api/rooms/secret'), 'WebSocket secret', null]) {
      expect(publicError(error)).toBe(
        'The transfer could not continue. Please start again with a new code.',
      );
    }
  });
});
