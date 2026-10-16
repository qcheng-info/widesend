# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use **Report a
vulnerability** on the repository's **Security** tab (GitHub private vulnerability
reporting). Include what you found, how to reproduce it, and which version or commit you
used. The maintainer follows up in the report, and a fix is published before the details are
made public. If you run your own instance, update it when a security fix is
released (see [docs/self-hosting.md](docs/self-hosting.md#update)).

The rest of this document describes WideSend's encryption, what it protects and what it
doesn't.

## Scope and trust

Version 2 replaces direct code-derived encryption with SPAKE2 and explicit mutual confirmation. The six boxes and automatic transfer/recovery flow stay the same. File traffic is encrypted in the browser before either WebRTC or Cloudflare relay sends it. File contents are never stored by the Worker.

The six-character code has approximately 31 bits of entropy. It authenticates the **initial pairing**, not the traffic key itself. Each connection establishes a fresh ephemeral shared secret. Knowing a code later, including reading it from the admin database, is not sufficient to decrypt a captured version-2 transfer.

A deployment with the admin dashboard intentionally stores plaintext pairing codes and reported filenames, sizes, and fingerprints for 90 days (it can stop recording filenames with `RECORD_FILE_NAMES: false`); one without the dashboard stores none of them (see [docs/admin.md](docs/admin.md)). The Worker also receives codes and connection credentials over TLS. The deterministic room locator, `SHA256("widesend-room-v1:" + code)`, permits offline enumeration of the code space. **We do not claim to hide codes from the relay, eliminate that dictionary attack, or protect initial pairing against an active operator who knows the code.** An attacker who knows a live code can impersonate a device during initial pairing. Admission limits, the 20-minute invitation window, and the limited receiver slots constrain joining but do not make a short code a high-entropy secret.

**Code uses.** A code can be used up to 10 times (the sender chooses; the default is 1). Each use claims its own slot and runs its own SPAKE2 exchange with its own pinned per-slot device keys, so one receiver cannot read or impersonate another's traffic: the Worker forwards frames only within a slot. A leaked code can be used by as many strangers as there are unclaimed uses, for up to 20 minutes (previously 10 minutes and one receiver). The sender sees how many times the code was used and can stop sharing it, which ends every unclaimed slot on the server. The Worker learns the number of uses and which slot each receiving device holds, nothing about file contents.

**Site name in the keys.** The key-exchange context carries the deployment's site name (`SITE`, served by `/api/health`) rather than the address in the browser bar, so every address of one deployment, and the command line through an API host, can pair. A deployment without `SITE` uses each page's own address, as before. The site name comes from the deployment, which is trusted anyway; a page that can't learn it falls back to its own address.

The Worker forwards an encrypted frame only after its sender has sent its share and confirmation for the current pairing round. A frame sent earlier was encrypted for a previous peer and is dropped instead of reaching a peer that is still pairing.

After mutual confirmation, each endpoint pins its peer's per-transfer signing public key. Every reconnection requires a valid fresh transcript signature by that same device. The corresponding private key stays on the endpoint. Knowing the code and Worker connection credentials alone therefore does not authenticate a replacement device after the pin has been saved.

The deployment serving JavaScript is trusted: modified frontend code could use browser keys or read files. A compromised browser profile or same-origin script can use non-exportable keys; non-exportability is not an XSS defense. Local staged files remain plaintext. Device-key compromise does not by itself reconstruct past ephemeral traffic keys, but compromise during transfer can expose current data/keys. This is not post-quantum cryptography.

## Protocol profile

The exchange implements [RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html), using its P256-SHA256-HKDF-HMAC suite and fixed M/N points. The sender is A, receiver B. `src/spake2.ts` handles the RFC transcript and key schedule using the P-256 point operations from pinned `@noble/curves` 2.4.0 and hash/KDF primitives from `@noble/hashes`. `tests/fixtures/spake2-rfc9382.json` contains the four published Appendix B vectors, checked in both directions.

- The application password mapping is scrypt over the exact six ASCII code characters, salt `widesend-v2-SPAKE2-P256-SHA256/password`, N=32768, r=8, p=1, output length 48 bytes. Interpret the output as a big-endian integer and reduce modulo the P-256 group order. Reject zero. This adds about 32 MiB of temporary pairing work, independent of file size; it does not prevent enumeration via the existing room locator.
- Ephemeral scalars use Web Crypto random bytes with rejection sampling in [1, order). Every connection attempt samples anew; none are persisted. Points use strict 65-byte uncompressed SEC1 encoding. Invalid points and the identity after unmasking are rejected. P-256 has cofactor 1.
- Each endpoint's identity is a length-prefixed role string and its 65-byte ECDSA P-256 public key. These are the RFC's A/B identities. Transcript length fields are eight-byte little endian; password scalars are padded 32-byte big endian.
- Additional authenticated data is the length-prefixed suite identifier, protocol version, browser origin, room locator, immutable session expiry, and fresh Worker pairing-round UUID. It enters the RFC confirmation KDF. Both endpoints must verify their peer's directional HMAC confirmation. Protocol version 2 is mandatory in updated clients, with no cipher downgrade path.
- Each confirmation also carries a Web Crypto ECDSA-P256/SHA256 signature over length-prefixed `suite/device-proof/role`, the context above, `SHA256(TT)`, and that endpoint's confirmation MAC. The peer key is checked against the saved pin, if any, and the signature must verify. The secret transcript/hash itself is never transmitted. Binding both fresh SPAKE2 shares, roles, identities, and the round prevents replay of an old device proof into a new exchange.
- Only after successful verification and durable peer-pin storage may the browser use the resulting cipher. The 16-byte RFC Ke supplies HKDF-SHA256 with salt SHA256(context) and info `widesend-v2/traffic/send` or `widesend-v2/traffic/receive`. The resulting AES-GCM keys are 256 bits; the overall P-256/SHA256 suite targets approximately **128-bit security**, not 256-bit security.
- AES-GCM additional data is SHA256(context), with the standard 16-byte tag. A 12-byte nonce contains a four-byte big-endian lane (0 control, 1 file) and an eight-byte big-endian monotonic counter. Each direction/lane starts at zero under fresh traffic keys. Counter allocation occurs before asynchronous encryption; a retransmission is encrypted again under a new counter. The counter cannot wrap.
- Each lane has an 8192-packet replay window, updated only after successful authentication. This allows bounded ordering differences between WebSocket and WebRTC. Encrypted replay is rejected; legitimate retransmission with a new nonce is handled by existing byte-offset/checkpoint rules. Frame size, relay batching, and file-integrity checks are unchanged.

The Worker forwards at most two bounded key-exchange messages per endpoint per pairing round. It never computes SPAKE2 secrets or receives device private keys. Old-round messages are ignored. The browser retries a stalled exchange after 20 seconds by reconnecting and creating new ephemeral state. Existing public-use admission limits still apply.

## Recovery and upgrade

A fresh endpoint creates its per-transfer, non-exportable ECDSA private key and saves it in IndexedDB **before sending its first share**. It saves the authenticated peer public key before sending application data. There is no persisted traffic key or synchronized shared resume-secret counter. If interruption happens after only one side saved a peer pin, both still have their original private keys and can authenticate a fresh exchange. Loss of a version-2 identity or a mismatched peer fails closed; WideSend does not generate a replacement identity for that record or clear an existing pin to retry.

Version-2 journal records contain the identity alongside existing code, credentials, fingerprints, expiry, and offsets. They are exclusive to one tab through the existing Web Lock. Completion, cancellation, or expiry removes the journal and its private key. Merely suspending a page preserves it for the original 24-hour recovery window. Browser storage eviction can make recovery impossible.

Previous version-1 journals are upgraded in place on refresh, retaining partial files, fingerprints, credentials, code and expiry. They acquire their first device identity/pin through SPAKE2. Because the old record did not authenticate a device key, this first upgraded exchange has the same operator/code trust boundary as initial pairing. New clients do not resume using the old cipher.

Both devices must refresh for a mixed-version transfer. The updated page shows refresh guidance and suspends without discarding its checkpoint. An old frontend skips version-2 records. Existing old/old tabs can finish using their previous protocol; this update does not retroactively protect traffic that used code-derived encryption. No Cloudflare secrets, bindings, Access changes, or D1 migrations are required.

## Assurance and limitations

Noble's primitives have their own [security reviews and documented timing limitations](https://github.com/paulmillr/noble-curves#security). Those reviews **do not constitute an audit of WideSend's SPAKE2 adapter, device-proof extension, or state machine**. This integration has known-answer, adversarial, server, and browser tests, but no independent cryptographic audit. JavaScript/BigInt, JIT compilation, and garbage collection do not guarantee constant-time execution or complete erasure of secret values. Temporary byte arrays are cleared where practical and ephemeral references discarded; that is best effort.

Public transfer diagnostics and admin activity reports do not include traffic keys, private device keys, SPAKE2 password scalars, or the secret transcript. Admin codes remain sensitive because of their initial-pairing role and because historical pre-upgrade recordings used the weaker cipher.

## Rooms

Rooms reuse the same primitives with a different trust anchor: the room creator's device.

- **Membership.** The creator's browser makes a non-exportable ECDSA P-256 key, the room's authority key. A joiner and the creator run the same SPAKE2 exchange as one-to-one pairing, using the room code. The context binds the room locator (`SHA-256("widesend-share-v1:" + code)`), the joiner's member ID and display name. Afterwards each knows the other's device key. The creator then signs a certificate over the room locator, member ID, role, name, device key and room expiry. Rosters from the server carry every certificate; browsers show only members whose certificate verifies against the authority key they learned through SPAKE2 (or stored at an earlier join). The server can't add a member or swap a key without the creator's signature.
- **Links between members.** Two members build a link with a fresh ECDH P-256 exchange. Each side signs its ephemeral key with its certified device key over the room, both member IDs and a round ID. HKDF-SHA256 turns the shared secret into the same `Cipher` used for one-to-one transfers (directional AES-256-GCM keys, counters, replay windows). A new round is made whenever a link restarts. Text messages, offers, answers, content keys, piece requests and WebRTC signalling travel only inside these links.
- **Messages.** A text message is sent separately over each recipient's link, so the server sees only its size and timing. Its list of recipients is the sender's claim and is only shown, never trusted. Recipients refuse messages that the room settings they see don't allow, as they do for offers.
- **Files.** Every offer is signed by the sender and lists names, sizes, full SHA-256 and MD5 fingerprints and a Merkle root per file (leaves `SHA-256(0x00 ‖ piece)`, nodes `SHA-256(0x01 ‖ left ‖ right)`). Each 512 KiB piece is encrypted once with a random AES-256-GCM key for that offer, using the file and piece numbers as the nonce and the offer ID as additional data; a piece always has the same plaintext, so this never reuses a nonce for different data. The content key is sent only to recipients who accept. A receiver writes a piece only after GCM authentication and a Merkle proof check against the signed root, then verifies the whole file again with SHA-256. Because every recipient gets identical ciphertext, the relay can copy one upload to several recipients, and a later version can let recipients pass pieces to each other without trusting them.
- **What the server sees.** Member IDs, display names, device public keys and certificates, room settings, who is online, message sizes and timing, and the relay fan-out lists. It does not see file names, sizes, contents or any keys in the clear: those travel inside member links or as encrypted pieces. Activity reports sent separately disclose file names, sizes and fingerprints to the site owner, as in one-to-one mode. In both modes browsers also tell the server why they close a connection (for example, a failed key check or no reply), and the activity log keeps that reason with the connection (see [docs/admin.md](docs/admin.md#diagnostics)).
- **What relies on the server.** Two room controls are enforced by the room on the server, not signed by the creator:
  - **Removal and leaving.** A member's certificate stays valid for the room's lifetime. A malicious server could keep listing a removed member, who could then still be offered files or send offers.
  - **Room settings.** Join mode, size and who may send are not signed by the creator. Browsers refuse offers and messages the settings they see don't allow, but a malicious server could change what they see.

  Neither lets the server read files or messages, forge a member or alter a piece.

- **History on the device.** Each browser keeps its room conversations, received files and its own sent images in its site storage (IndexedDB and the origin-private file system), unencrypted, until the person deletes them under **Past rooms**, like completed one-to-one downloads. Anyone with access to that browser profile can read them. Browsers report only a running count and total size of each member's text messages to the activity log, never their contents.

- **Boundary.** As with one-to-one pairing, joining is only as strong as the six-character code against an operator who knows it. A room accepts joins for up to 24 hours while the creator is online, a longer window than the 20-minute invitation, so **approval mode is the stronger setting**. The deployment serving the JavaScript remains trusted.
