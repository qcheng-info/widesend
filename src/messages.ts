// Only approved, actionable messages reach the public interface. Browser errors
// and messages received from another device may contain implementation details.
const messages = new Map<string, string>([
  [
    'Could not verify the other device. Start again with a new code.',
    'Could not verify the other device. Start again with a new code.',
  ],
  ['Select the same original files to continue.', 'Select the same original files to continue.'],
  [
    'Saved transfer data is missing.',
    'Saved progress is no longer available. Please start a new transfer.',
  ],
  ['Could not save transfer progress.', 'Allow this site to save files, then try again.'],
  [
    'This transfer is open in another tab.',
    'This transfer was opened in another tab. Continue there or start again.',
  ],
  [
    'There isn’t enough space for these files. Free up space or choose another device.',
    'There isn’t enough space for these files. Free up space or choose another device.',
  ],
  [
    'Enter the complete 6-character code (A–Z and 0–9).',
    'Enter the complete 6-character code (A–Z and 0–9).',
  ],
  ['This code expired. Start a new transfer.', 'This code expired. Start a new transfer.'],
  [
    'This code has already been used. Ask the sender for a new code.',
    'This code has already been used. Ask the sender for a new code.',
  ],
  ['This session expired. Create a new transfer.', 'This code expired. Start a new transfer.'],
  [
    'This connection was replaced by another tab.',
    'This transfer was opened in another tab. Continue there or start again.',
  ],
  [
    'The connection was rejected. Start a new transfer.',
    'Could not join this transfer. Ask the sender for a new code.',
  ],
  [
    'Could not reconnect. Check the code, keep the sender online, and make sure this transfer has not already been claimed.',
    'Could not reconnect. Check the code and keep the sender’s page open.',
  ],
  ['Transfer cancelled.', 'Transfer cancelled.'],
  ['The other device ended the transfer.', 'The other device ended the transfer.'],
  ['The file list is too large. Send fewer files at once.', 'Send fewer files at once.'],
  ['Transfer is too large.', 'Send fewer files at once.'],
  [
    'The source file changed during transfer.',
    'A selected file changed. Select it again and start a new transfer.',
  ],
  [
    'This browser cannot stream large files to disk. Update your browser or use Chrome, Safari, or Firefox.',
    'This browser cannot receive these files. Update it or try another browser.',
  ],
  [
    'This browser is blocking local disk storage. Use a regular (non-private) window and allow site storage.',
    'Your browser cannot save files here. Use a regular (non-private) window and allow this site to save files.',
  ],
  [
    'Not enough browser storage for these files. Free space or receive on a desktop using “Choose destination”.',
    'There isn’t enough space for these files. Free up space or choose another device.',
  ],
  [
    'No disk space available.',
    'There isn’t enough space for these files. Free up space or choose another device.',
  ],
  [
    'Browser disk storage failed. Try an updated browser in a regular window.',
    'Could not save your files. Try an updated browser in a regular window.',
  ],
  [
    'The browser saved an incomplete file. Use a regular window with enough free storage, or choose a desktop destination.',
    'The file was not saved completely. Try again in a regular browser window with enough free space.',
  ],
  [
    'The saved file did not pass its integrity check. Retry using a regular browser window or a different destination.',
    'The received file could not be checked. Please send it again.',
  ],
]);

export function publicError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError')
    return 'There isn’t enough space. Free up space and try again.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Allow this site to save files, then try again.';
  if (name === 'AbortError') return 'Nothing was saved. Choose a destination to try again.';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    messages.get(message) ?? 'The transfer could not continue. Please start again with a new code.'
  );
}
