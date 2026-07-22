/** UCC-style index: FACULTY/PROGRAM/YEAR/SEQ e.g. PS/CSC/24/0057 */
const FACULTY_CODE = 'PS';

const PROGRAM_LIST = [
  { code: 'PHY', label: 'BSc Physics' },
  { code: 'CSC', label: 'BSc Computer Science' },
  { code: 'MTH', label: 'BSc Mathematics' },
  { code: 'CHM', label: 'BSc Chemistry' },
  { code: 'BIO', label: 'BSc Biology' },
  { code: 'STA', label: 'BSc Statistics' },
];

const INDEX_PART_LENS = [2, 3, 2, 4];
const INDEX_MAX_CHARS = 11;
const INDEX_PATTERN = /^[A-Z]{2}\/[A-Z]{3}\/\d{2}\/\d{4}$/;
const PROGRAM_CODES = new Set(PROGRAM_LIST.map((p) => p.code));

function formatIndexNumberMasked(raw) {
  const chars = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, INDEX_MAX_CHARS);

  const parts = [];
  let offset = 0;
  for (const len of INDEX_PART_LENS) {
    if (chars.length <= offset) break;
    parts.push(chars.slice(offset, offset + len));
    offset += len;
  }
  return parts.join('/');
}

function normalizeIndexNumber(indexNumber) {
  return formatIndexNumberMasked(indexNumber);
}

function isValidIndexNumber(indexNumber) {
  const value = normalizeIndexNumber(indexNumber);
  if (!INDEX_PATTERN.test(value)) return false;
  return PROGRAM_CODES.has(value.split('/')[1]);
}

function indexFormatHint() {
  return 'Format: PS/CSC/24/0057';
}

/**
 * Build: [PS] / [CSC] / [24] / [0057] with always-visible slash separators.
 * Syncs into a hidden (or target) input[name=index_number].
 */
function bindIndexNumberSegments(container) {
  if (!container || container.dataset.indexSegBound === '1') return;
  container.dataset.indexSegBound = '1';

  const target =
    container.querySelector('input[name="index_number"]') ||
    document.getElementById(container.dataset.indexTarget || '');

  const lens = INDEX_PART_LENS;
  const types = ['text', 'text', 'numeric', 'numeric'];
  const placeholders = ['PS', 'CSC', '24', '0057'];

  const row = document.createElement('div');
  row.className = 'index-seg-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Index number');

  const inputs = lens.map((len, i) => {
    if (i > 0) {
      const slash = document.createElement('span');
      slash.className = 'index-slash';
      slash.textContent = '/';
      slash.setAttribute('aria-hidden', 'true');
      row.appendChild(slash);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'index-seg';
    input.maxLength = len;
    input.placeholder = placeholders[i];
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.inputMode = types[i] === 'numeric' ? 'numeric' : 'text';
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('aria-label', `Index part ${i + 1}`);
    input.dataset.seg = String(i);
    row.appendChild(input);
    return input;
  });

  // Keep the real field for forms, but don't show a second box
  if (target) {
    target.type = 'hidden';
    target.removeAttribute('required');
    target.dataset.indexMask = '1';
  }

  const hint = document.createElement('p');
  hint.className = 'index-format-hint meta';
  hint.textContent = indexFormatHint();

  container.appendChild(row);
  container.appendChild(hint);

  function joined() {
    return inputs.map((el) => el.value.toUpperCase()).join('/');
  }

  function syncTarget() {
    const value = normalizeIndexNumber(joined());
    if (target) {
      target.value = value;
      target.setCustomValidity(isValidIndexNumber(value) || !value ? '' : indexFormatHint());
    }
    hint.textContent = value && !isValidIndexNumber(value) ? `Invalid — use ${indexFormatHint()}` : indexFormatHint();
    hint.classList.toggle('index-format-error', Boolean(value) && !isValidIndexNumber(value));
  }

  function fillFrom(raw) {
    const chars = String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, INDEX_MAX_CHARS);
    let offset = 0;
    inputs.forEach((input, i) => {
      const len = lens[i];
      input.value = chars.slice(offset, offset + len);
      offset += len;
    });
    syncTarget();
  }

  if (target?.value) fillFrom(target.value);

  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      const allow = i < 2 ? /[^A-Za-z]/g : /[^0-9]/g;
      let v = input.value.toUpperCase().replace(allow, '');
      if (v.length > lens[i]) v = v.slice(0, lens[i]);
      input.value = v;
      syncTarget();
      if (v.length === lens[i] && inputs[i + 1]) inputs[i + 1].focus();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && inputs[i - 1]) {
        e.preventDefault();
        inputs[i - 1].focus();
        const prev = inputs[i - 1];
        prev.value = prev.value.slice(0, -1);
        syncTarget();
      }
      if (e.key === '/' || e.key === '\\') {
        e.preventDefault();
        if (inputs[i + 1]) inputs[i + 1].focus();
      }
    });

    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') || '';
      if (!text) return;
      e.preventDefault();
      fillFrom(text);
      const lastFilled = [...inputs].reverse().find((el) => el.value) || inputs[0];
      lastFilled.focus();
    });
  });

  container._indexSync = syncTarget;
  container._indexFill = fillFrom;
  syncTarget();
}

function bindIndexNumberMask(input) {
  // Prefer segmented UI when a wrapper exists
  const wrap = input?.closest('[data-index-segments]');
  if (wrap) {
    bindIndexNumberSegments(wrap);
    return;
  }
  if (!input || input.dataset.indexMaskBound === '1') return;
  input.dataset.indexMaskBound = '1';
  input.setAttribute('inputmode', 'text');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('autocapitalize', 'characters');
  input.maxLength = INDEX_MAX_CHARS + 3;
  input.placeholder = 'PS/CSC/24/0057';
  input.addEventListener('input', () => {
    input.value = formatIndexNumberMasked(input.value);
  });
  input.addEventListener('blur', () => {
    input.value = formatIndexNumberMasked(input.value);
  });
}

function bindAllIndexNumberMasks(root = document) {
  root.querySelectorAll('[data-index-segments]').forEach(bindIndexNumberSegments);
  root.querySelectorAll('input[name="index_number"], input[data-index-mask]').forEach((input) => {
    if (input.closest('[data-index-segments]')) return;
    bindIndexNumberMask(input);
  });
}

function programGroupFromIndex(indexNumber) {
  const parts = String(indexNumber || '').split('/').map((p) => p.trim());
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return 'Other';
}

function programLabelFromIndex(indexNumber) {
  const code = String(indexNumber || '').split('/')[1];
  const match = PROGRAM_LIST.find((p) => p.code === code);
  return match ? match.label : code || 'Unknown programme';
}

function programCodeFromIndex(indexNumber) {
  return String(indexNumber || '').split('/')[1] || '';
}
