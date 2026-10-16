# Using WideSend

1. On the sender, choose **Send files**, select up to 100 files, and create a transfer. **Code uses** sets how many times the code can be used (1 to 10, default 1).
2. Share the six-character code or link with the receiving device. Codes use uppercase letters and digits, with at least one of each (for example, `A1B2C3`). Anyone with the code can claim the transfer, as many times as the code can be used.
3. On the receiver, open the same WideSend deployment and choose **Receive files**. Type or paste the code; lowercase input is converted to uppercase. You can also open a shared link.
4. Click **Receive**. Files download using your browser’s configured download location; WideSend does not open a destination picker. WideSend tries direct connectivity for up to five seconds before using the encrypted relay.
5. Keep both devices awake and both tabs open. Each verified file automatically starts a browser download. Check your browser’s downloads; use the **Download** link to retry if an automatic download was blocked. The browser may prompt based on its own settings, including permissions for multiple downloads.

The pairing window is 20 minutes. Claimed sessions can last up to 24 hours. Each receiving browser is pinned to its own slot of the session; another browser cannot take it over. Someone who arrives after every use is taken is told at once that the code has already been used. After cancelling, create a new code.

## Using a code more than once

Raise **Code uses** before creating the transfer to let the code be used several times, for example to hand the same files to a group, or to one person on two devices. Each use is a device opening the code or link in its own browser (or running `widesend receive`), and each gets its own one-to-one transfer: its own key exchange, direct or relay route, checkpoints, verification and recovery, exactly as with a single use. The sender uploads the files once per use.

- **Using the code.** A use is spent when a device connects with the code. Every use must happen within the 20-minute window; unused ones lapse. The sender sees "Used 2 of 3 times" and a row per use with its progress.
- **Stop sharing.** Once the code has been used, the sender can stop sharing it: it can't be used again, and transfers in progress carry on. **Cancel transfer** cancels every use still receiving.
- **Ending.** The send ends when every use has finished and the code can't be used any more (every use taken, the window closed, or the sender stopped sharing). A receiver who cancels ends only their own use.
- **Reload.** A reopened sender asks once for the original files and resumes every use still in progress; uses that already finished stay listed.

Rooms remain the place for ongoing conversations and sending things back and forth.

## Automatic recovery

No Pause or Resume buttons are required. Keep the pages open for continuous transfer; if a connection disappears, WideSend waits and continues automatically when both devices return. Reopen the same website in the same browser profile after closing a page or restarting the browser. The receiver automatically reopens its local partial file. A reopened sender shows **Select original files** because browsers do not retain ordinary file-picker access across page lifetimes. Select all the original files; WideSend matches names, sizes, and SHA-256 fingerprints (selection order does not matter), then continues automatically. A different file with the same name and size is rejected without discarding the saved transfer.

The receiver flushes data to disk before committing a checkpoint to IndexedDB, at least every 1 MiB or after a second of arriving data. On recovery it truncates any uncommitted tail and resumes at the committed offset, so a small tail may be sent again. Every completed file is still verified in full before its download is requested. Previously completed files retain Download links after recovery. Cancellation removes the local resume record and unverified partial files; completed download backing files remain protected. A missing/truncated checkpoint fails safely. Browser storage remains subject to eviction and available space.

Pairing credentials and the original expiry are kept in Durable Object storage until 24 hours after session creation, so the original participants can reconnect even when both sockets have closed. Only this small session record is persisted there; file contents and partial files remain on the devices. Expiry uses a Durable Object alarm, independently of the existing 90-day admin activity retention. An unclaimed invitation still expires after 20 minutes, and a different receiver cannot claim a slot that is already paired. A Web Lock prevents another tab from restoring the same local transfer while it is active. Fresh and resumed transfers try a new direct connection, including LAN connectivity, before falling back to the encrypted relay. Stale connections and their pending negotiation work are discarded. Each attempt has a five-second fallback deadline once the transfer is accepted; file bytes wait until a direct or relay route is selected.

Browser suspension can stop transmission until you return to the page; automatic recovery does not enable background file transfer. No new login, binding, migration, or deployment setting is needed for this feature.

A successful direct route carries both encrypted file chunks and delivery acknowledgements. This removes the Cloudflare round trip from the frequent acknowledgement window, including on a LAN. Cloudflare still carries pairing, connection negotiation, file lifecycle messages, keepalives, and activity reports; internet access is still required. The STUN service discovers connection candidates and does not relay file contents. Matching public IPs are not used to decide whether a LAN connection is possible. Browser restrictions, VPNs, and network isolation may still prevent a local route.

## Live transfer statistics

During a transfer, select **Nerd stats** beneath the progress bar. The panel starts collapsed, matches the site language, and retains a final snapshot after completion, cancellation, or failure. It shows direct/relay routing, current and average throughput, a speed graph covering up to the last 60 seconds, elapsed time and estimated time remaining, peer round-trip latency, local queued bytes, file progress, verification counts, reconnection attempts, relay reasons, and recent events. Senders additionally see bytes awaiting acknowledgement and resent file data. Both sides show the last observed acknowledgement path. A direct connection also shows its selected ICE candidate types, UDP/TCP transport, and an address-type hint when the browser exposes them.

Connection-path details are read from the selected WebRTC candidate pair at most every three seconds. Local host addresses or mDNS names on both ends are labeled **Local addresses (LAN likely)**; this is a hint, not proof, since VPNs can also use local addresses. Public addresses can still route locally. Hidden addresses and unavailable statistics stay unknown. Raw candidate IPs from these statistics are not displayed, persisted, or added to activity reports, and statistics failures do not affect transmission.

Statistics update about once per second. Throughput counts receiver-acknowledged bytes on the sender and successfully written bytes on the receiver, excluding replayed bytes. Average throughput includes stalls, reconnection, and verification time since that device started the transfer. After a page is restored, timing and throughput restart for the remaining bytes while file progress includes the saved checkpoint. Each device's counters and timing are local; the two views can differ slightly. Verification confirms the received file's checksum, not the browser's final download save.

Latency uses small encrypted probes on the active file-data route, roughly every five seconds per device (and after route changes), with at most one outstanding probe. It includes queues and processing on both devices; it is not a raw network ping. Missing, stale (15 seconds), or unsupported measurements show **—** and do not fail the transfer. Probes stop when that device's transfer ends; the final snapshot preserves the last available reading. Speed history is limited to 61 samples and the event list to 30 entries. These diagnostics stay in page memory and are not added to the admin database.

## Rooms

A room is a conversation for a group or for two people. Open **Create a room** and share the code or the `/#room=CODE` link; others open **Join a room** (or the link). Inside, type a message, or paste, drop or attach images and files, and press **Send** (or Enter; Shift+Enter starts a new line, and on phones Enter adds a line). Everything appears in one timeline, so you don't enter a code again for the next item. With one other person it's a one-to-one chat; in a group, the **To** row picks who gets the next item (it starts at **Everyone** and remembers your choice). Use it between your own devices, with a friend, or for a meeting or classroom.

The room creator decides:

| Setting      | Options                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| Who can join | Anyone with the code, or only people the creator approves                                 |
| Room size    | 2 to 20 people, including the creator (`ROOM_LIMITS.maxMembers`)                          |
| Who can send | Only the creator (the default); everyone to anyone; members only to the creator (hand-in) |

"Who can send" covers messages as well as files. The creator can change settings, remove a member, or close the room for everyone, from **Room details**. Rooms last up to 24 hours. While the creator's page is closed, existing members keep talking but nobody new can join: the creator's device vouches for every member (see [SECURITY.md](../SECURITY.md#rooms)). In auto-join mode a removed person could join again with the code, so switch to approval mode first.

- **Arriving on their own.** A send of 100 MiB or less (one paste, drop or attach) is accepted automatically. Bigger sends show **Accept** / **Decline**. Images show in the conversation; every file has a **Download** button. Nothing downloads by itself.
- **Someone away.** Messages and files wait on the sender's device and are delivered when the other person comes back, as long as the sender's page is open. Messages still waiting survive the sender reloading the page; files do not, and show **Not delivered**.
- **History.** Each device keeps its own copy of the conversation in the browser's site storage, including received files and the sender's own images, until you delete it. History starts when you join. After a room ends it's listed under **Past rooms** on the **Create a room** and **Join a room** tabs, where **View** shows it and **Delete** removes it. A private window can't keep history.

Membership survives a reload: the page rejoins without asking again. File transfers in a room survive a dropped connection but not a reload or closed page — the other side is told and marks that delivery failed. For large, resumable one-to-one transfers use **Send files**.

How files travel: each file is split into 512 KiB pieces. The sender encrypts every piece once with a random key for that offer, which only people who accept receive, and signs a Merkle root per file. Receivers request a few pieces at a time and check each one before writing it. Pairs try a direct WebRTC connection first; otherwise the room relays. On the relay, one upload is copied to every recipient who needs that piece, so sending to a group costs about one upload, not one per person. Received files are verified with SHA-256 and kept with the conversation. Text messages travel inside the same encrypted member links, which are acknowledged and sent again until they arrive. This piece format is ready for a later step in which recipients also pass pieces to each other.

## Large files and browser support

The transfer protocol uses safe integer byte offsets, 32 KiB direct chunks and disk writes, and a 1 MiB application window. Relay traffic combines up to sixteen chunks into a single 512 KiB payload. It supports multi-megabyte and multi-gigabyte files without reading the whole file into JavaScript memory. Before sending bytes, the sender computes and saves full SHA-256 and MD5 fingerprints using bounded reads. Final verification reads the saved file once more as a bounded stream. Large files therefore need an initial checking pass; file contents are never copied into the recovery journal.

All receivers stream to private browser storage (OPFS) on the receiving device, verify the completed file, and request a normal browser download. Missing OPFS support, denied storage, or insufficient quota is reported before file contents are sent; there is no unbounded RAM fallback. Browser settings control the destination and duplicate-filename handling.

Browser private storage is subject to local quota and available disk space. Saving a downloaded copy may temporarily require space for both copies. Use a regular browser window for large files. Private browsing can have smaller quotas, deny disk storage entirely, or impose export limits; Safari receivers must use a regular browsing window. Normal Chrome and WebKit profiles passed the included 2 GiB-plus transfer, saved-file verification, and downloaded-file SHA-256 checks. Mobile operating systems may suspend or terminate a background tab; a screen wake lock is requested when supported, but **background transfer is not guaranteed**. Transfers reconnect automatically after interruptions. Reopening WideSend in the same browser profile restores saved progress, including after a reload or browser restart, within the original 24-hour session window. Recovery depends on the browser retaining its site data; it cannot survive cleared/evicted storage, private-window closure, or a switch to a different device/browser profile.

Verified temporary files and their download URLs stay available for the page lifetime, including after **New transfer** or cancellation of a later file. This avoids deleting a browser download’s backing data too early. Unverified partial files are removed on cancellation/reset. On startup and before receiving, WideSend attempts to delete managed temporary folders unused for more than 24 hours, only when no tab holds their Web Lock. Each completed file/download attempt refreshes the timestamp. Cleanup is best effort; browsers without Web Locks and legacy folders are left alone. Site data can still be cleared through browser settings. There is no cloud file copy to recover.

**Files received** means all bytes arrived and their fingerprints were verified in browser storage. A website cannot reliably observe whether the browser finished saving an ordinary download. Neither the public completion message nor the admin record claims that the final Downloads-folder copy was verified.

## Languages

The public interface supports English, Simplified Chinese, French, Spanish, Japanese, and Korean. It selects a supported browser language on first visit; the language menu saves your choice on that device. Changing language does not interrupt a transfer. The admin interface remains in English.
