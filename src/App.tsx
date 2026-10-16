import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  Copy,
  FileUp,
  Info,
  Link,
  LoaderCircle,
  LockKeyhole,
  Minus,
  Plus,
  LogIn,
  MessageSquarePlus,
  X,
} from 'lucide-react';
import { Transfer, type Snapshot } from './transfer';
import { SendSession, restoreTransfer, type GroupSnapshot } from './send-session';
import { MultiSendView } from './MultiSendView';
import { aboutSite, apiHostTarget, loadSite } from './site';
import { aboutLines } from './about';
import { normalizeCodeInput } from './crypto';
import { publicError } from './messages';
import { CodeInput } from './CodeInput';
import { cleanupOldDownloads, type SavedFile } from './storage';
import { MAX_FILES, MAX_RECEIVERS } from '../shared/protocol';
import { useLanguage } from './i18n';
import { LanguagePicker } from './LanguagePicker';
import { NerdStats } from './NerdStats';
import { formatBytes } from './format';
import { FileIcon } from './FileIcon';
import { RoomHome } from './room/RoomHome';
import { RoomView } from './room/RoomView';
import { useRoom } from './room/useRoom';
// Room links are /#room=CODE; one-to-one links stay /#CODE.
const roomLink = /^#room=/i.test(location.hash) ? normalizeCodeInput(location.hash.slice(6)) : '';
// The link's #CODE or #room=CODE as opened, before the page tidies its address bar.
const openedHash = location.hash;
function Logo() {
  return (
    <span className="logo-mark">
      <img src="/widesend.svg" alt="" width="39" height="39" />
    </span>
  );
}

export default function App() {
  const { language, setLanguage, t } = useLanguage();
  const initialCode = useRef(roomLink ? '' : normalizeCodeInput(location.hash.slice(1)));
  const [tab, setTab] = useState<'send' | 'receive' | 'create-room' | 'join-room'>(
    roomLink ? 'join-room' : initialCode.current ? 'receive' : 'send',
  );
  const rooms = useRoom();
  const [code, setCode] = useState(initialCode.current);
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<Snapshot>();
  // How many times the code can be used. Above 1, a SendSession runs one transfer per use.
  const [uses, setUses] = useState(1);
  const [group, setGroup] = useState<GroupSnapshot>();
  const sending = useRef<SendSession | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [about, setAbout] = useState(aboutSite);
  const booted = useRef(false);
  const originals = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState('');
  const [help, setHelp] = useState(false);
  const transfer = useRef<Transfer | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const active =
    (state && !['complete', 'error', 'cancelled'].includes(state.phase)) ||
    group?.phase === 'active';

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) location.reload();
    });
    void (async () => {
      try {
        // Keys use the deployment's site name; learn it before anything pairs.
        await loadSite();
        setAbout(aboutSite());
        // A page opened on an API-only host (the command line's server) belongs on the site.
        const site = apiHostTarget(openedHash);
        if (site) {
          location.replace(site);
          return;
        }
        const restored = await restoreTransfer(setState, setGroup);
        if (restored && 'session' in restored) {
          sending.current = restored.session;
          setGroup(restored.session.snapshot);
          await restored.session.start();
        } else if (restored) {
          transfer.current = restored.transfer;
          setState(restored.transfer.snapshot);
          await restored.transfer.start();
        } else if (!roomLink && (await rooms.restore())) setTab('join-room');
      } catch (err) {
        setError(publicError(err));
        await transfer.current?.dispose().catch(() => {});
        await sending.current?.dispose().catch(() => {});
        transfer.current = undefined;
        sending.current = undefined;
        setState(undefined);
        setGroup(undefined);
      } finally {
        setBusy(false);
        void cleanupOldDownloads().catch(() => {});
      }
    })();
  }, []);

  async function selectOriginals(items: FileList | null) {
    if (!items?.length) return;
    setError('');
    try {
      if (sending.current) await sending.current.supplyFiles(Array.from(items));
      else await transfer.current?.supplyFiles(Array.from(items));
    } catch (err) {
      setError(publicError(err));
    }
  }

  function addFiles(items: FileList | File[] | null) {
    if (!items) return;
    const next = [...files, ...Array.from(items)];
    if (next.length > MAX_FILES) {
      setError('Too many files. Remove some and try again.');
      return;
    }
    setFiles(next);
    setError('');
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      if (tab === 'send' && uses > 1) {
        const session = SendSession.create(files, uses, setGroup);
        sending.current = session;
        setGroup(session.snapshot);
        await session.start();
      } else {
        const next =
          tab === 'send' ? Transfer.sender(files, setState) : Transfer.receiver(code, setState);
        transfer.current = next;
        setState(next.snapshot);
        await next.start();
      }
    } catch (err) {
      setError(publicError(err));
      await transfer.current?.dispose().catch(() => {});
      await sending.current?.dispose().catch(() => {});
      transfer.current = undefined;
      sending.current = undefined;
      setState(undefined);
      setGroup(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    await transfer.current?.dispose();
    await sending.current?.dispose();
    transfer.current = undefined;
    sending.current = undefined;
    setState(undefined);
    setGroup(undefined);
    setError('');
    setFiles([]);
    setUses(1);
    setCode('');
  }
  async function accept() {
    setBusy(true);
    setError('');
    try {
      await transfer.current!.accept();
    } catch (err) {
      setError(publicError(err));
    } finally {
      setBusy(false);
    }
  }
  async function openRoom(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(publicError(err));
    } finally {
      setBusy(false);
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Clipboard access was blocked. Select and copy the code manually.');
    }
  }
  async function share(file: SavedFile) {
    try {
      if (file.file) await navigator.share({ files: [file.file] });
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError')
        setError('Sharing failed. Use the Download button instead.');
    }
  }
  const percent = state
    ? state.phase === 'complete'
      ? 100
      : state.total
        ? Math.min(100, (state.transferred / state.total) * 100)
        : 0
    : 0;
  const timeLeft =
    state && state.speed > 0 ? Math.ceil((state.total - state.transferred) / state.speed) : 0;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            if (active || rooms.snapshot?.phase === 'in-room') event.preventDefault();
          }}
          aria-label={t('WideSend home')}
        >
          <Logo />
          <span>
            wide<span className="brand-light">send</span>
            <span className="brand-dot">.</span>
          </span>
        </a>
        <div className="header-right">
          <LanguagePicker language={language} onChange={setLanguage} label={t('Language')} />
          <button className="text-button help-button" onClick={() => setHelp(!help)}>
            <Info size={16} />
            <span>{t('How it works')}</span>
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <h1>{t('Send files anywhere.')}</h1>
          <p>{t('Choose files, share a code, and keep both devices open.')}</p>
        </section>

        {help && (
          <aside className="help-panel">
            <button
              className="icon-button close-help"
              onClick={() => setHelp(false)}
              aria-label={t('Close help')}
            >
              <X size={18} />
            </button>
            <h2>{t('Send in a few simple steps.')}</h2>
            <p>
              {t(
                'Choose your files and select Create transfer. On the other device, open WideSend, choose Receive files, and enter the six-character code.',
              )}
            </p>
            <p>
              {t(
                'Keep both devices awake and these tabs open. Files download using your browser’s settings. Check its downloads before leaving; use Download if a file is missing.',
              )}
            </p>
            <p>
              {t(
                'Share the code only with the people you want to receive the files. It expires in 20 minutes.',
              )}
            </p>
            <p>
              {t(
                'To send the same files to several people or devices, raise Code uses before you create the transfer. To keep sending things back and forth, create a room.',
              )}
            </p>
            <h3>{t('This site')}</h3>
            {aboutLines(about).map((line) => (
              <p key={line.text}>
                {line.link ? (
                  <a href={line.link} target="_blank" rel="noopener noreferrer">
                    {t(line.text)}
                  </a>
                ) : (
                  t(line.text, line.values)
                )}
              </p>
            ))}
          </aside>
        )}

        <section
          className={`transfer-card ${state || group || rooms.snapshot ? 'session-card' : ''}`}
          aria-label={t('File transfer')}
        >
          {rooms.snapshot ? (
            <RoomView
              snapshot={rooms.snapshot}
              room={rooms.room}
              onClose={() => {
                void rooms.close();
                setError('');
              }}
              t={t}
            />
          ) : group ? (
            <MultiSendView
              group={group}
              busy={busy}
              copied={copied}
              onCopy={(value, label) => void copy(value, label)}
              onSelectOriginals={(items) => void selectOriginals(items)}
              onStopSharing={() => sending.current?.stopSharing()}
              onCancel={() => sending.current?.cancel()}
              onReset={() => void reset()}
              t={t}
            />
          ) : !state ? (
            <>
              <div className="tabs" role="tablist" aria-label={t('Transfer mode')}>
                {(
                  [
                    ['send', 'Send files', ArrowUpRight],
                    ['receive', 'Receive files', ArrowDown],
                    ['create-room', 'Create a room', MessageSquarePlus],
                    ['join-room', 'Join a room', LogIn],
                  ] as const
                ).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    role="tab"
                    aria-selected={tab === value}
                    className={tab === value ? 'selected' : ''}
                    onClick={() => {
                      setTab(value);
                      setError('');
                    }}
                  >
                    <Icon size={20} />
                    {t(label)}
                  </button>
                ))}
              </div>
              {tab === 'create-room' || tab === 'join-room' ? (
                <RoomHome
                  mode={tab === 'create-room' ? 'create' : 'join'}
                  initialCode={roomLink}
                  busy={busy}
                  environment={rooms.environment()}
                  onCreate={(name, settings) => void openRoom(() => rooms.create(name, settings))}
                  onJoin={(code, name) => void openRoom(() => rooms.join(code, name))}
                  onOpen={(locator) =>
                    void openRoom(async () => {
                      if (!(await rooms.restore(locator)))
                        throw new Error(
                          'This room has expired. Rooms stay open for up to 24 hours.',
                        );
                    })
                  }
                  t={t}
                />
              ) : (
                <div className="card-body">
                  <div className="card-heading">
                    <div>
                      <h2>
                        {tab === 'send' ? t('Choose your files') : t('Enter a transfer code')}
                      </h2>
                      <p id={tab === 'receive' ? 'receive-code-hint' : undefined}>
                        {tab === 'send'
                          ? t('Select files to send.')
                          : t('Enter the code from the sending device.')}
                      </p>
                    </div>
                  </div>
                  {tab === 'send' ? (
                    <>
                      <input
                        ref={input}
                        type="file"
                        multiple
                        hidden
                        data-testid="file-input"
                        onChange={(event) => {
                          addFiles(event.target.files);
                          event.target.value = '';
                        }}
                      />
                      <button
                        className={`drop-zone ${dragging ? 'dragging' : ''}`}
                        onClick={() => input.current?.click()}
                        onDragOver={(event) => {
                          event.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(event) => {
                          event.preventDefault();
                          setDragging(false);
                          addFiles(event.dataTransfer.files);
                        }}
                      >
                        <span className="upload-illustration">
                          <span className="paper paper-back" />
                          <span className="paper paper-front">
                            <FileUp size={30} strokeWidth={1.5} />
                          </span>
                          <span className="plus-bubble">
                            <Plus size={16} />
                          </span>
                        </span>
                        <strong>
                          {dragging ? t('Drop them right here') : t('Drop your files here')}
                        </strong>
                        <span>{t('or choose files on your device')}</span>
                      </button>
                      {files.length > 0 && (
                        <div className="selected-files">
                          {files.map((file, i) => (
                            <div className="file-row" key={`${file.name}-${i}`}>
                              <FileIcon name={file.name} />
                              <div className="file-description">
                                <strong>{file.name}</strong>
                                <span>{formatBytes(file.size)}</span>
                              </div>
                              <button
                                className="icon-button"
                                aria-label={t('Remove {name}', { name: file.name })}
                                onClick={() => setFiles(files.filter((_, index) => index !== i))}
                              >
                                <X size={17} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div className="code-uses-setting">
                          <div>
                            <strong id="code-uses-label">{t('Code uses')}</strong>
                            <span>{t('How many times the code can be used')}</span>
                          </div>
                          <div className="stepper" role="group" aria-labelledby="code-uses-label">
                            <button
                              className="icon-button"
                              aria-label={t('Fewer uses')}
                              disabled={uses <= 1}
                              onClick={() => setUses(uses - 1)}
                            >
                              <Minus size={16} />
                            </button>
                            <output data-testid="code-uses" aria-live="polite">
                              {uses}
                            </output>
                            <button
                              className="icon-button"
                              aria-label={t('More uses')}
                              disabled={uses >= MAX_RECEIVERS}
                              onClick={() => setUses(uses + 1)}
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="action-row">
                        <span className="selection-caption">
                          {files.length
                            ? `${t(files.length === 1 ? '{count} file' : '{count} files', { count: files.length })} · ${formatBytes(files.reduce((sum, f) => sum + f.size, 0))}`
                            : t('No files selected')}
                        </span>
                        <button
                          className="primary-button"
                          disabled={!files.length || busy}
                          onClick={() => void start()}
                        >
                          {t('Create transfer')}
                          <ArrowRight size={18} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void start();
                      }}
                      className="receive-form"
                    >
                      <label
                        className="visually-hidden"
                        id="receive-code-label"
                        htmlFor="receive-code"
                      >
                        {t('Transfer code')}
                      </label>
                      <CodeInput
                        value={code}
                        onChange={setCode}
                        characterLabel={(index) => t('Code character {index} of 6', { index })}
                      />
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={!/^[A-Z0-9]{6}$/.test(code) || busy}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={18} />
                        ) : (
                          <ArrowDown size={18} />
                        )}
                        {t('Connect to sender')}
                      </button>
                    </form>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="session-header">
                <span>
                  <span className="status-dot" />
                  {state.role === 'send' ? t('OUTGOING TRANSFER') : t('INCOMING TRANSFER')}
                </span>
                <span className="route-badge" data-testid="connection-status">
                  <span className="status-dot" />
                  {state.phase === 'complete'
                    ? t(state.role === 'send' ? 'Delivered' : 'Received')
                    : state.phase === 'error'
                      ? t('Needs attention')
                      : state.phase === 'cancelled'
                        ? t('Cancelled')
                        : state.phase === 'reconnecting'
                          ? t('Reconnecting…')
                          : state.phase === 'connecting'
                            ? t('Connecting…')
                            : state.phase === 'waiting'
                              ? t('Waiting for receiver')
                              : t('Connected')}
                </span>
              </div>
              <div className="card-body">
                {state.role === 'send' &&
                !state.needsFiles &&
                ['connecting', 'waiting'].includes(state.phase) ? (
                  <>
                    <div className="card-heading">
                      <div>
                        <h2>{t('Share this code')}</h2>
                        <p>{t('Open WideSend on your other device to receive.')}</p>
                      </div>
                    </div>
                    <div className="pairing">
                      <div className="pairing-details">
                        <span className="small-label">{t('TRANSFER CODE')}</span>
                        <code className="transfer-code" data-testid="transfer-code">
                          {state.code}
                        </code>
                        <div className="copy-actions">
                          <button
                            className="secondary-button"
                            onClick={() => void copy(state.code, 'code')}
                          >
                            {copied === 'code' ? <Check size={16} /> : <Copy size={16} />}
                            {copied === 'code' ? t('Copied') : t('Copy code')}
                          </button>
                          <button
                            className="text-button"
                            onClick={() => void copy(`${location.origin}/#${state.code}`, 'link')}
                          >
                            {copied === 'link' ? <Check size={16} /> : <Link size={16} />}
                            {copied === 'link' ? t('Copied') : t('Copy link')}
                          </button>
                        </div>
                        <span className="field-note">
                          {t('Can be used once · Code expires in 20 minutes')}
                        </span>
                      </div>
                    </div>
                    <div className="waiting-line">
                      <LoaderCircle size={17} className="spin" />
                      {t('Waiting for your other device…')}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="card-heading">
                      <div>
                        <h2>
                          {state.needsFiles && active
                            ? t('Continue your transfer')
                            : state.phase === 'complete'
                              ? t(state.role === 'send' ? 'Files delivered.' : 'Files received.')
                              : state.phase === 'offered'
                                ? t('Ready to receive.')
                                : state.phase === 'error'
                                  ? t('Transfer failed.')
                                  : state.phase === 'cancelled'
                                    ? t('Transfer cancelled.')
                                    : state.phase === 'reconnecting'
                                      ? t('Reconnecting…')
                                      : state.role === 'send'
                                        ? t('Sending files…')
                                        : t('Receiving files…')}
                        </h2>
                        <p role="status">{t(state.message)}</p>
                      </div>
                      {state.phase === 'complete' && (
                        <span className="complete-icon">
                          <CheckCheck size={26} />
                        </span>
                      )}
                    </div>
                    {['transferring', 'reconnecting', 'complete'].includes(state.phase) && (
                      <div className="progress-section">
                        <div className="progress-label">
                          <strong>
                            {Math.floor(percent)}
                            <span>%</span>
                          </strong>
                          <span>
                            {formatBytes(state.transferred)} / {formatBytes(state.total)}
                          </span>
                        </div>
                        <div
                          className="progress-track"
                          role="progressbar"
                          aria-label={t('Transfer progress')}
                          aria-valuenow={Math.floor(percent)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div style={{ width: `${percent}%` }} />
                        </div>
                        <div className="progress-stats">
                          <span>
                            {state.phase === 'complete'
                              ? t(state.role === 'send' ? 'Files delivered.' : 'Files received.')
                              : state.phase === 'reconnecting'
                                ? t('Progress saved on this device')
                                : `${formatBytes(state.speed)}/s`}
                          </span>
                          <span>
                            {state.phase === 'complete'
                              ? t('100% there')
                              : timeLeft
                                ? t(
                                    timeLeft < 60 ? '{count}s remaining' : '{count} min remaining',
                                    { count: timeLeft < 60 ? timeLeft : Math.ceil(timeLeft / 60) },
                                  )
                                : t('Estimating time…')}
                          </span>
                        </div>
                      </div>
                    )}
                    {state.needsFiles && active && (
                      <div className="receive-actions">
                        <input
                          ref={originals}
                          type="file"
                          multiple
                          hidden
                          data-testid="original-files"
                          onChange={(event) => {
                            void selectOriginals(event.target.files);
                            event.target.value = '';
                          }}
                        />
                        <button
                          className="primary-button"
                          disabled={state.checkingFiles || busy}
                          onClick={() => originals.current?.click()}
                        >
                          {state.checkingFiles ? (
                            <LoaderCircle size={18} className="spin" />
                          ) : (
                            <FileUp size={18} />
                          )}
                          {t(
                            state.checkingFiles
                              ? 'Checking your original files…'
                              : 'Select original files',
                          )}
                        </button>
                      </div>
                    )}
                    <NerdStats state={state} t={t} />
                    <div className="transfer-files">
                      {state.files.map((file) => {
                        const saved = state.saved.find((f) => f.id === file.id);
                        return (
                          <div className="file-row" key={file.id}>
                            <FileIcon name={file.name} />
                            <div className="file-description">
                              <strong>{file.name}</strong>
                              <span>
                                {formatBytes(file.size)}
                                {saved ? ` · ${t('Verified')}` : ''}
                              </span>
                            </div>
                            {saved?.url && (
                              <div className="save-actions">
                                <a
                                  className="secondary-button"
                                  href={saved.url}
                                  download={saved.name}
                                  onClick={() => saved.keepAvailable()}
                                >
                                  <ArrowDownToLine size={16} />
                                  {t('Download')}
                                </a>
                                {saved.file && navigator.canShare?.({ files: [saved.file] }) && (
                                  <button
                                    className="icon-button"
                                    onClick={() => void share(saved)}
                                    aria-label={t('Share {name}', { name: saved.name })}
                                  >
                                    <ArrowUpRight size={18} />
                                  </button>
                                )}
                              </div>
                            )}
                            {state.role === 'send' && state.phase === 'complete' && (
                              <Check size={20} className="success-text" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {state.phase === 'offered' && (
                      <>
                        <p className="field-note">
                          {t(
                            'Files download using your browser’s settings. Keep this page open until they are ready.',
                          )}
                        </p>
                        <div className="receive-actions">
                          <button
                            className="primary-button"
                            disabled={busy}
                            onClick={() => void accept()}
                          >
                            {busy ? (
                              <LoaderCircle size={18} className="spin" />
                            ) : (
                              <ArrowDownToLine size={18} />
                            )}
                            {t('Receive')}
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
                <div className="session-footer">
                  <span>
                    <LockKeyhole size={14} />
                    {t('Keep your code private')}
                  </span>
                  {['complete', 'error', 'cancelled'].includes(state.phase) ? (
                    <button className="text-button" onClick={() => void reset()}>
                      {t('New transfer')}
                      <ArrowRight size={16} />
                    </button>
                  ) : (
                    <button
                      className="text-button cancel-button"
                      onClick={() => transfer.current?.cancel()}
                    >
                      {t('Cancel transfer')}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <Info size={18} />
              <span>{t(error)}</span>
              <button
                className="icon-button"
                aria-label={t('Dismiss error')}
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </section>
        <div className="keep-open-note">
          <Info size={14} />
          {t('Keep both devices awake and these tabs open until the transfer finishes.')}
        </div>
      </main>
    </div>
  );
}
