import { useLayoutEffect, useRef } from 'react';
import { normalizeCodeInput } from './crypto';

export function CodeInput({
  value,
  onChange,
  characterLabel,
  labelledBy = 'receive-code-label',
  describedBy = 'receive-code-hint',
  firstId = 'receive-code',
}: {
  value: string;
  onChange: (code: string) => void;
  characterLabel: (index: number) => string;
  labelledBy?: string;
  describedBy?: string;
  firstId?: string;
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const characters = value.padEnd(6, ' ').split('');
  useLayoutEffect(() => {
    inputs.current.find((input) => input === document.activeElement)?.select();
  }, [value]);
  function focus(index: number) {
    inputs.current[Math.max(0, Math.min(5, index))]?.focus();
  }
  function insert(text: string, index: number) {
    const incoming = normalizeCodeInput(text);
    if (!incoming) return;
    const start = incoming.length === 6 ? 0 : index;
    const next = [...characters];
    for (let i = 0; i < incoming.length && start + i < 6; i++) next[start + i] = incoming[i];
    onChange(next.join('').trimEnd());
    focus(start + incoming.length);
  }
  function clear(index: number) {
    const next = [...characters];
    next[index] = ' ';
    onChange(next.join('').trimEnd());
  }
  return (
    <div className="code-input" role="group" aria-labelledby={labelledBy}>
      {characters.map((character, index) => (
        <input
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
          }}
          id={index === 0 ? firstId : undefined}
          aria-label={characterLabel(index + 1)}
          aria-describedby={describedBy}
          value={character.trim()}
          maxLength={6}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          required
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
          onChange={(event) => {
            if (!event.target.value) clear(index);
            else insert(event.target.value, index);
          }}
          onPaste={(event) => {
            event.preventDefault();
            insert(event.clipboardData.getData('text'), index);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              event.preventDefault();
              const previous = character.trim() ? index : Math.max(0, index - 1);
              clear(previous);
              focus(previous);
            } else if (event.key === 'Delete') {
              event.preventDefault();
              clear(index);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              focus(index + (event.key === 'ArrowLeft' ? -1 : 1));
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              focus(event.key === 'Home' ? 0 : 5);
            }
          }}
        />
      ))}
    </div>
  );
}
