import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { detectLanguage, languages, translate } from '../../src/i18n';
import { translations } from '../../src/locales';
import { publicError } from '../../src/messages';

describe('public translations', () => {
  it('matches browser regional preferences with an English fallback', () => {
    expect(detectLanguage(['de-DE', 'fr-CA', 'en'])).toBe('fr');
    expect(detectLanguage(['zh-TW'])).toBe('zh');
    expect(detectLanguage(['ko-KR'])).toBe('ko');
    expect(detectLanguage(['ja-JP'])).toBe('ja');
    expect(detectLanguage(['es-MX'])).toBe('es');
    expect(detectLanguage(['en-CA', 'fr-CA'])).toBe('en');
    expect(detectLanguage(['de', 'invalid'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
  });
  it('has all five translations with matching interpolation fields', () => {
    const fields = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(([key]) => key).sort();
    for (const [source, row] of Object.entries(translations)) {
      expect(row).toHaveLength(5);
      for (const text of row) {
        expect(text.trim().length, source).toBeGreaterThan(0);
        expect(fields(text), source).toEqual(fields(source));
      }
    }
    for (const { code } of languages) {
      expect(translate(code, 'Remove {name}', { name: '<photo>{count}.jpg' })).toContain(
        '<photo>{count}.jpg',
      );
      expect(translate(code, '{count} files', { count: 12 })).toContain('12');
      expect(translate(code, '')).toBe('');
    }
  });
  it('covers UI text, transfer messages, and sanitized errors', () => {
    const covered = (text: string) => expect(translations, text).toHaveProperty(text);
    for (const file of [
      'App.tsx',
      'MultiSendView.tsx',
      'send-session.ts',
      'NerdStats.tsx',
      'metrics.ts',
      'transfer.ts',
      'messages.ts',
      'room/RoomHome.tsx',
      'room/RoomView.tsx',
      'room/RoomDetails.tsx',
      'room/ConversationView.tsx',
      'room/Composer.tsx',
      'room/PastRooms.tsx',
      'room/room-ui.tsx',
      'room/room.ts',
      'room/transfers.ts',
      'room/messages.ts',
      'room/conversation.ts',
    ]) {
      const ast = ts.createSourceFile(
        file,
        readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      function strings(n: ts.Node) {
        if (ts.isStringLiteral(n) && n.text) covered(n.text);
        else if (ts.isConditionalExpression(n)) {
          strings(n.whenTrue);
          strings(n.whenFalse);
        }
      }
      function visit(n: ts.Node) {
        if (
          ts.isCallExpression(n) &&
          (['t', 'setError'].includes(n.expression.getText(ast)) ||
            /\.(record|useRelay)$/.test(n.expression.getText(ast))) &&
          n.arguments[0]
        )
          strings(n.arguments[0]);
        if (ts.isPropertyAssignment(n) && ['message', 'activity'].includes(n.name.getText(ast)))
          strings(n.initializer);
        if (ts.isBinaryExpression(n) && n.left.getText(ast) === 'this.message') strings(n.right);
        // Room engine: sentences shown to people as delivery messages or errors.
        if (file.startsWith('room/')) {
          // incomingEnded(inc, status, message) / deliveryEnded(out, d, status, message)
          const call = ts.isCallExpression(n) ? n.expression.getText(ast) : '';
          const position = /incomingEnded$/.test(call) ? 2 : /deliveryEnded$/.test(call) ? 3 : -1;
          if (ts.isCallExpression(n) && position >= 0 && n.arguments[position])
            strings(n.arguments[position]);
          if (ts.isNewExpression(n) && n.expression.getText(ast) === 'Error' && n.arguments?.[0])
            strings(n.arguments[0]);
          // Label tables ([title, text] pairs and status → label maps).
          if (
            ts.isStringLiteral(n) &&
            n.text.length > 1 &&
            /[.…?]$|^[A-Z][a-z]/.test(n.text) &&
            (ts.isArrayLiteralExpression(n.parent) || ts.isPropertyAssignment(n.parent)) &&
            ['room/RoomView.tsx', 'room/ConversationView.tsx'].includes(file)
          )
            covered(n.text);
        }
        if (
          file === 'NerdStats.tsx' &&
          ts.isArrayLiteralExpression(n) &&
          n.elements.length === 3 &&
          ts.isStringLiteral(n.elements[0]) &&
          ts.isStringLiteral(n.elements[1])
        ) {
          let owner: ts.Node | undefined = n.parent;
          while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
          if (owner && ts.isVariableDeclaration(owner) && owner.name.getText(ast) === 'metrics')
            strings(n.elements[1]);
        }
        if (
          file === 'messages.ts' &&
          ts.isArrayLiteralExpression(n) &&
          n.elements.length === 2 &&
          ts.isStringLiteral(n.elements[1])
        )
          strings(n.elements[1]);
        if (
          file === 'messages.ts' &&
          ts.isReturnStatement(n) &&
          n.expression &&
          ts.isStringLiteral(n.expression)
        )
          strings(n.expression);
        ts.forEachChild(n, visit);
      }
      visit(ast);
    }
    for (const { code } of languages.filter((l) => l.code !== 'en')) {
      const safe = publicError(new Error('Internal /api/secret'));
      expect(translate(code, safe)).not.toBe(safe);
      expect(translate(code, safe)).not.toContain('/api/secret');
    }
  });
});
