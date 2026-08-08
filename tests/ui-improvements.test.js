import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('UI A1: action and safe accents have distinct roles', async () => {
  const css = await read('style.css');
  const action = css.match(/--accent-action:\s*([^;]+);/)?.[1];
  const safe = css.match(/--accent-safe:\s*([^;]+);/)?.[1];
  assert.ok(action && safe);
  assert.notEqual(action, safe);
  assert.match(css, /\.primary-button\s*\{[^}]*var\(--accent\)/s);
  assert.match(css, /\.status-line\[data-mode="p2p"\][^}]*var\(--accent-safe-soft\)/s);
  assert.doesNotMatch(css, /\.(?:primary|secondary|compact|danger|text)-button\s*\{[^}]*var\(--accent-safe/s);
});

test('UI A2: verification stage suppresses ambient motion and uses a weighted border', async () => {
  const [css, app] = await Promise.all([read('style.css'), read('app.js')]);
  assert.match(app, /document\.body\.dataset\.handshakeStage = stage/);
  assert.match(app, /localSafetyConfirmed \|\| remoteSafetyConfirmed \? 'pending'/);
  assert.match(css, /body\[data-handshake-stage="verifying"\] \.ambient\s*\{[^}]*opacity:\s*0/s);
  assert.match(css, /body\[data-handshake-stage="verifying"\][^}]*\.security-panel\s*\{[^}]*border:\s*2px/s);
  assert.match(css, /data-verification="pending"[^}]*border-color:[^}]*--caution/s);
});

test('UI A3: magnetic button pointer tracking is fully removed', async () => {
  const [html, css, app] = await Promise.all([read('index.html'), read('style.css'), read('app.js')]);
  assert.doesNotMatch(html, /data-magnetic/);
  assert.doesNotMatch(css, /magnetic-x|magnetic-y|data-magnetic/);
  assert.doesNotMatch(app, /magnetic-x|magnetic-y|querySelectorAll\('\[data-magnetic\]'/);
});

test('UI B1-B4: early setup warning, distinct recovery severity, grouped settings and manual context exist', async () => {
  const [html, css] = await Promise.all([read('index.html'), read('style.css')]);
  const rolePicker = html.match(/<section class="handshake-role-picker[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(rolePicker, /data-i18n="reloadSetupWarning"/);
  assert.match(css, /\.manual-transfer\s*\{[^}]*--caution/s);
  assert.match(css, /\.ratchet-recovery\s*\{[^}]*--danger/s);
  assert.equal((html.match(/data-i18n="conveniencePersistence"/g) ?? []).length, 1);
  assert.equal((html.match(/data-i18n="alternativeTechnicalModes"/g) ?? []).length, 1);
  assert.equal((html.match(/data-i18n="manualTransportStatus"/g) ?? []).length, 1);
});

test('UI B5: mobile contacts have a complete dialog path', async () => {
  const [html, css, app] = await Promise.all([read('index.html'), read('style.css'), read('app.js')]);
  assert.match(html, /id="mobile-contacts-trigger"/);
  assert.match(html, /id="mobile-contacts-dialog"/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.mobile-contacts-trigger\s*\{\s*display:\s*flex/);
  assert.match(app, /mobile-contacts-trigger'[\s\S]*showModal/);
  assert.match(app, /Mobile keeps contacts out of the primary rail/);
});

test('UI B6: settings use an icon-only header trigger and balanced viewport dialog', async () => {
  const [html, css, app] = await Promise.all([read('index.html'), read('style.css'), read('app.js')]);
  const header = html.match(/<header class="site-header[\s\S]*?<\/header>/)?.[0] ?? '';
  const trigger = header.match(/<button[^>]*id="advanced-settings"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(trigger, /class="[^"]*icon-button[^"]*settings-header-button[^"]*"/);
  assert.match(trigger, /aria-haspopup="dialog"/);
  assert.doesNotMatch(trigger, /data-i18n="advancedSettings"/);
  assert.ok(header.indexOf('theme-toggle') < header.indexOf('id="advanced-settings"'));
  assert.match(html, /<dialog class="settings-dialog" id="advanced-panel"/);
  assert.doesNotMatch(html, /class="settings-trigger"/);
  assert.match(css, /\.settings-dialog\s*\{[^}]*--settings-edge:[^}]*width:\s*calc\(100vw - \(var\(--settings-edge\) \* 2\)\)[^}]*height:\s*calc\(100dvh - \(var\(--settings-edge\) \* 2\)\)/s);
  assert.match(css, /\.settings-dialog-content\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
  assert.match(app, /advanced-settings'[\s\S]*panel\.showModal\(\)/);
  assert.match(app, /close-settings'[\s\S]*advanced-panel'\)\.close\(\)/);
});

test('UI C1: IP disclosure follows valid sender preview before answer creation', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
  const joinCard = html.match(/<section class="workflow-block glass"><div class="block-heading"><span>02[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.ok(joinCard.indexOf('ip-disclosure') < joinCard.indexOf('id="create-answer"'));
  assert.match(app, /offer-sender-preview'[\s\S]*querySelector\('\.ip-disclosure'\)/);
  assert.match(app, /disclosure\?\.classList\.remove\('is-hidden'\)/);
});

test('UI B3/C2: all locales include new labels and no standalone E2E marketing claim exists', async () => {
  const localeUrl = new URL('i18n/', root);
  const files = (await readdir(localeUrl)).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 11);
  for (const file of files) {
    const locale = JSON.parse(await read(`i18n/${file}`));
    for (const key of ['conveniencePersistence', 'alternativeTechnicalModes', 'reloadSetupWarning', 'manualTransportStatus', 'closeContacts', 'closeSettings']) {
      assert.equal(typeof locale[key], 'string', `${file} is missing ${key}`);
      assert.ok(locale[key].trim(), `${file} has an empty ${key}`);
    }
  }
  const marketing = `${await read('index.html')}\n${await Promise.all(files.map((file) => read(`i18n/${file}`))).then((parts) => parts.join('\n'))}`;
  assert.doesNotMatch(marketing, /\bend[- ]to[- ]end encrypted\b/iu);
});

test('UI preflight: HTML ids are unique and every i18n binding has an English fallback', async () => {
  const html = await read('index.html');
  const english = JSON.parse(await read('i18n/en.json'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/gu)].map((match) => match[1]);
  for (const key of keys) assert.equal(typeof english[key], 'string', `English fallback is missing ${key}`);
});
