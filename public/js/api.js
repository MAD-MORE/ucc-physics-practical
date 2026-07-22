const API = {
  tokenKey: 'ucc_phys_token',
  userKey: 'ucc_phys_user',

  getToken() {
    return localStorage.getItem(this.tokenKey);
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.userKey) || 'null');
    } catch {
      return null;
    }
  },

  setSession(token, user) {
    localStorage.setItem(this.tokenKey, token);
    localStorage.setItem(this.userKey, JSON.stringify(user));
  },

  clearSession() {
    localStorage.removeItem(this.tokenKey);
    localStorage.removeItem(this.userKey);
  },

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };
    const token = this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`/api${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let data = null;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text || 'Unexpected response' };
    }

    if (!res.ok) {
      const err = new Error(data?.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
};

function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value == null ? '' : String(value);
}

function showAlert(el, message, type = 'error') {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  const kind = type === 'ok' || type === 'info' || type === 'error' ? type : 'error';
  el.className = `alert alert-${kind}`;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAlert(el) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.classList.add('hidden');
  el.textContent = '';
}

function bindClick(id, handler) {
  const el = $(id);
  if (el) el.addEventListener('click', handler);
  return el;
}

function closeOnBackdropOrEscape(modal, onClose) {
  if (!modal || typeof onClose !== 'function') return;
  modal.addEventListener('click', (e) => {
    if (e.target === modal && !modal.dataset.busyLock) onClose();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden') && !modal.dataset.busyLock) onClose();
  });
}

const Busy = {
  depth: 0,

  ensure() {
    let el = $('app-busy-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'app-busy-overlay';
    el.className = 'busy-overlay hidden';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = `
      <div class="busy-card">
        <div class="busy-spinner" aria-hidden="true"></div>
        <p class="busy-message">Please wait…</p>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  },

  show(message = 'Please wait…') {
    const el = this.ensure();
    const msg = el.querySelector('.busy-message');
    if (msg) msg.textContent = message;
    this.depth += 1;
    el.classList.remove('hidden');
    document.body.classList.add('is-busy');
  },

  hide() {
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth > 0) return;
    const el = $('app-busy-overlay');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('is-busy');
  },

  async run(fn, message = 'Please wait…') {
    this.show(message);
    try {
      return await fn();
    } finally {
      this.hide();
    }
  },
};

function setBusyButton(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.setAttribute('aria-busy', 'true');
    if (busyLabel) btn.textContent = busyLabel;
  } else {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.removeAttribute('aria-busy');
    if (btn.dataset.idleLabel) {
      btn.textContent = btn.dataset.idleLabel;
      delete btn.dataset.idleLabel;
    }
  }
}

function lockControls(root, locked) {
  const scope = typeof root === 'string' ? $(root) : root;
  if (!scope) return;
  scope.querySelectorAll('button, input, select, textarea, a.btn').forEach((el) => {
    if (locked) {
      if (el.dataset.lockOwned === '1') return;
      el.dataset.lockWasDisabled = el.disabled ? '1' : '0';
      el.dataset.lockOwned = '1';
      el.disabled = true;
    } else if (el.dataset.lockOwned === '1') {
      el.disabled = el.dataset.lockWasDisabled === '1';
      delete el.dataset.lockWasDisabled;
      delete el.dataset.lockOwned;
    }
  });
}

function onceAsync(fn) {
  let inflight = false;
  return async function onceAsyncWrapper(...args) {
    if (inflight) return;
    inflight = true;
    try {
      return await fn.apply(this, args);
    } finally {
      inflight = false;
    }
  };
}

function confirmAction({
  title = 'Confirm',
  message = 'Are you sure?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let backdrop = $('app-confirm-modal');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'app-confirm-modal';
      backdrop.className = 'modal-backdrop hidden';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      backdrop.innerHTML = `
        <div class="modal-card confirm-card">
          <h3 id="app-confirm-title"></h3>
          <p class="lede" id="app-confirm-message"></p>
          <div class="modal-actions">
            <button type="button" class="btn btn-primary" id="app-confirm-ok"></button>
            <button type="button" class="btn btn-secondary" id="app-confirm-cancel"></button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
    }

    const titleEl = $('app-confirm-title');
    const messageEl = $('app-confirm-message');
    const okBtn = $('app-confirm-ok');
    const cancelBtn = $('app-confirm-cancel');
    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    const finish = (value) => {
      backdrop.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
    };

    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) finish(false);
    };
    document.addEventListener('keydown', onKey);
    backdrop.classList.remove('hidden');
    okBtn.focus();
  });
}

function requireRole(role, redirect = '/') {
  const user = API.getUser();
  const token = API.getToken();
  if (!token || !user || user.role !== role) {
    window.location.href = redirect;
    return null;
  }
  return user;
}

function formatDate(d) {
  if (!d) return '';
  const date = typeof d === 'string' && d.length <= 10 ? new Date(d + 'T00:00:00') : new Date(d);
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatTime(t) {
  if (!t) return '';
  const raw = String(t).slice(0, 5);
  const [hStr, mStr] = raw.split(':');
  let hours = Number(hStr);
  const minutes = mStr || '00';
  if (Number.isNaN(hours)) return raw;
  const period = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${period}`;
}
