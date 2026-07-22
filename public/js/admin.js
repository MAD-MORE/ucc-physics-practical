(function () {
  const user = requireRole('admin', '/');
  if (!user) return;

  const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dirtySchedules = new Map();
  const scheduleRevisions = new Map();
  const autoSaveTimers = new Map();
  const savingPromises = new Map();
  const editBaselines = new Map();
  const undoStack = [];
  const redoStack = [];
  let activeSaves = 0;
  let allowNavigation = false;
  let applyingHistory = false;

  setText('user-chip', user.full_name || user.username);
  bindClick(
    'logout-btn',
    onceAsync(async () => {
      if (dirtySchedules.size || activeSaves) {
        const saveFirst = await confirmAction({
          title: 'Unsaved changes',
          message: 'Save your schedule edits before signing out?',
          confirmLabel: 'Save & sign out',
          cancelLabel: 'No',
        });
        if (saveFirst) {
          const saved = await saveAllSchedules();
          if (!saved) return;
        } else {
          const discard = await confirmAction({
            title: 'Discard changes?',
            message: 'Sign out and discard unsaved schedule edits? This cannot be undone.',
            confirmLabel: 'Discard & sign out',
            danger: true,
          });
          if (!discard) return;
        }
      }
      allowNavigation = true;
      API.clearSession();
      window.location.href = '/';
    })
  );

  const alertEl = document.getElementById('page-alert');

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function timeValue(t) {
    return String(t || '').slice(0, 5);
  }

  function statesEqual(a, b) {
    return (
      a.start_time === b.start_time &&
      a.end_time === b.end_time &&
      a.min_participants === b.min_participants &&
      a.max_participants === b.max_participants
    );
  }

  const historyCommitTimers = new Map();

  function setAutosaveState(el, text, state) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-idle', 'is-saved', 'is-pending', 'is-saving', 'is-error');
    if (state) el.classList.add(state);
  }

  function updateSaveUi() {
    const button = $('save-all-schedules');
    const status = $('schedule-save-status');
    const undoBtn = $('undo-schedules');
    const redoBtn = $('redo-schedules');
    if (!button || !status || !undoBtn || !redoBtn) return;

    const pendingCount = dirtySchedules.size;
    const hasPendingTimers = autoSaveTimers.size > 0;

    if (activeSaves) {
      setAutosaveState(status, 'Saving…', 'is-saving');
    } else if (pendingCount || hasPendingTimers) {
      setAutosaveState(
        status,
        `${Math.max(pendingCount, hasPendingTimers ? 1 : 0)} change${pendingCount === 1 ? '' : 's'} pending`,
        'is-pending'
      );
    } else {
      setAutosaveState(status, 'All changes saved', 'is-idle');
    }

    button.disabled = Boolean(activeSaves) || (!pendingCount && !hasPendingTimers);
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function readScheduleState(id) {
    const cards = $('schedule-cards');
    if (!cards) return null;
    const start = cards.querySelector(`[data-start-edit="${id}"]`);
    if (!start) return null;
    const row = start.closest('[data-schedule-day]');
    const day = row?.dataset.scheduleDay;
    const end = cards.querySelector(`[data-end-edit="${id}"]`);
    const min = cards.querySelector(`[data-min-edit="${id}"]`);
    const max = cards.querySelector(`[data-max-edit="${id}"]`);
    if (!end || !min || !max || !day) return null;
    return {
      day_of_week: day,
      start_time: timeValue(start.value),
      end_time: timeValue(end.value),
      min_participants: Number(min.value),
      max_participants: Number(max.value),
    };
  }

  function writeScheduleState(id, state) {
    const cards = $('schedule-cards');
    if (!cards || !state) return false;
    const start = cards.querySelector(`[data-start-edit="${id}"]`);
    const end = cards.querySelector(`[data-end-edit="${id}"]`);
    const min = cards.querySelector(`[data-min-edit="${id}"]`);
    const max = cards.querySelector(`[data-max-edit="${id}"]`);
    if (!start || !end || !min || !max) return false;
    start.value = timeValue(state.start_time);
    end.value = timeValue(state.end_time);
    min.value = String(state.min_participants);
    max.value = String(state.max_participants);
    return true;
  }

  function ensureBaseline(id) {
    if (!editBaselines.has(id)) {
      const state = readScheduleState(id);
      if (state) editBaselines.set(id, { ...state });
    }
    return editBaselines.get(id) || null;
  }

  function markScheduleDirty(id, day) {
    const revision = (scheduleRevisions.get(id) || 0) + 1;
    scheduleRevisions.set(id, revision);
    dirtySchedules.set(String(id), { day, revision });
    const rowStatus = document.querySelector(`[data-save-state="${id}"]`);
    setAutosaveState(rowStatus, 'Pending', 'is-pending');
    updateSaveUi();
  }

  function cancelAutoSave(id) {
    clearTimeout(autoSaveTimers.get(id));
    autoSaveTimers.delete(id);
  }

  function queueAutoSave(id) {
    cancelAutoSave(id);
    autoSaveTimers.set(
      id,
      setTimeout(() => {
        autoSaveTimers.delete(id);
        saveSchedule(id).catch((err) => showAlert(alertEl, err.message));
        updateSaveUi();
      }, 700)
    );
    updateSaveUi();
  }

  function pushHistory(entry) {
    if (!entry?.before || !entry?.after || statesEqual(entry.before, entry.after)) return;
    undoStack.push({
      id: String(entry.id),
      before: { ...entry.before },
      after: { ...entry.after },
    });
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
    updateSaveUi();
  }

  function commitHistory(id) {
    const before = editBaselines.get(id);
    const after = readScheduleState(id);
    if (!before || !after) return;
    if (!statesEqual(before, after)) {
      pushHistory({ id, before, after });
      editBaselines.set(id, { ...after });
    }
  }

  function queueHistoryCommit(id) {
    clearTimeout(historyCommitTimers.get(id));
    historyCommitTimers.set(
      id,
      setTimeout(() => {
        historyCommitTimers.delete(id);
        commitHistory(id);
      }, 450)
    );
  }

  function flushHistoryCommits() {
    for (const [id, timer] of historyCommitTimers.entries()) {
      clearTimeout(timer);
      historyCommitTimers.delete(id);
      commitHistory(id);
    }
  }

  function applyHistoryState(id, state) {
    cancelAutoSave(id);
    clearTimeout(historyCommitTimers.get(id));
    historyCommitTimers.delete(id);
    if (!writeScheduleState(id, state)) {
      showAlert(alertEl, 'That session is no longer available to undo/redo');
      return false;
    }
    editBaselines.set(id, { ...state });
    markScheduleDirty(id, state.day_of_week);
    queueAutoSave(id);
    return true;
  }

  function undoEdit() {
    flushHistoryCommits();
    const entry = undoStack.pop();
    if (!entry) {
      updateSaveUi();
      return;
    }
    applyingHistory = true;
    const current = readScheduleState(entry.id);
    if (!current || !applyHistoryState(entry.id, entry.before)) {
      undoStack.push(entry);
      applyingHistory = false;
      updateSaveUi();
      return;
    }
    redoStack.push({ id: entry.id, before: entry.before, after: current });
    applyingHistory = false;
    updateSaveUi();
    showAlert(alertEl, 'Undid last session edit', 'info');
  }

  function redoEdit() {
    flushHistoryCommits();
    const entry = redoStack.pop();
    if (!entry) {
      updateSaveUi();
      return;
    }
    applyingHistory = true;
    const current = readScheduleState(entry.id);
    if (!current || !applyHistoryState(entry.id, entry.after)) {
      redoStack.push(entry);
      applyingHistory = false;
      updateSaveUi();
      return;
    }
    undoStack.push({ id: entry.id, before: current, after: entry.after });
    applyingHistory = false;
    updateSaveUi();
    showAlert(alertEl, 'Redid session edit', 'info');
  }

  function clearHistory() {
    for (const timer of historyCommitTimers.values()) clearTimeout(timer);
    historyCommitTimers.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    // Keep editBaselines; they are re-seeded after each render
    editBaselines.clear();
    updateSaveUi();
  }

  async function saveSchedule(id) {
    const key = String(id);
    if (savingPromises.has(key)) {
      await savingPromises.get(key);
      if (dirtySchedules.has(key)) return saveSchedule(key);
      return true;
    }

    const pending = dirtySchedules.get(key);
    if (!pending) return true;
    cancelAutoSave(key);

    const revision = pending.revision;
    const payload = readScheduleState(key);
    if (!payload) {
      dirtySchedules.delete(key);
      updateSaveUi();
      return true;
    }
    const rowStatus = document.querySelector(`[data-save-state="${key}"]`);
    activeSaves += 1;
    setAutosaveState(rowStatus, 'Saving…', 'is-saving');
    updateSaveUi();

    const promise = API.request(`/admin/schedules/${key}`, {
      method: 'PATCH',
      body: payload,
    });
    savingPromises.set(key, promise);

    try {
      await promise;
      if (dirtySchedules.get(key)?.revision === revision) {
        dirtySchedules.delete(key);
        setAutosaveState(rowStatus, 'Saved', 'is-saved');
      } else {
        queueAutoSave(key);
      }
      return true;
    } catch (err) {
      setAutosaveState(rowStatus, 'Save failed', 'is-error');
      throw err;
    } finally {
      savingPromises.delete(key);
      activeSaves -= 1;
      updateSaveUi();
    }
  }

  async function saveAllSchedules({ quiet = false } = {}) {
    flushHistoryCommits();
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    autoSaveTimers.clear();

    // Capture any focused field that is mid-edit
    const active = document.activeElement;
    const activeId =
      active?.dataset?.startEdit ||
      active?.dataset?.endEdit ||
      active?.dataset?.minEdit ||
      active?.dataset?.maxEdit;
    if (activeId) {
      ensureBaseline(activeId);
      commitHistory(activeId);
      const state = readScheduleState(activeId);
      if (state) markScheduleDirty(activeId, state.day_of_week);
    }

    const ids = [...dirtySchedules.keys()];
    if (!ids.length) {
      if (!quiet) showAlert(alertEl, 'Nothing to save', 'info');
      updateSaveUi();
      return true;
    }

    const run = async () => {
      const results = await Promise.allSettled(ids.map((id) => saveSchedule(id)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) {
        showAlert(alertEl, failed.reason?.message || 'Save failed');
        updateSaveUi();
        return false;
      }
      if (!quiet) showAlert(alertEl, 'All session changes saved', 'ok');
      updateSaveUi();
      return true;
    };

    return quiet ? run() : Busy.run(run, 'Saving schedule changes…');
  }

  async function loadOverview() {
    const data = await API.request('/admin/overview');
    setText('stat-students', data.students);
    setText('stat-regs', data.registrations);
    setText('stat-schedules', data.schedules);
    setText('stat-open', data.registration_open ? 'Open' : 'Closed');
  }

  async function loadSchedules({ preserveHistory = false } = {}) {
    const data = await API.request('/admin/schedules');
    const cards = document.getElementById('schedule-cards');
    const byDay = {};
    for (const day of DAY_ORDER) byDay[day] = [];

    for (const s of data.schedules) {
      const day = s.day_of_week || 'Monday';
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(s);
    }

    if (!preserveHistory) clearHistory();
    dirtySchedules.clear();
    scheduleRevisions.clear();
    for (const timer of autoSaveTimers.values()) clearTimeout(timer);
    autoSaveTimers.clear();

    cards.innerHTML = DAY_ORDER.map((day) => {
      const slots = byDay[day]
        .slice()
        .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

      const timesHtml = slots.length
        ? slots
            .map((s) => {
              const nextStatus = s.status === 'open' ? 'closed' : 'open';
              return `
            <div class="day-time-row admin-time-row" data-schedule-day="${escapeHtml(day)}" data-schedule-id="${s.schedule_id}">
              <div class="session-editor">
                <div class="meta">
                  ${Number(s.registration_count || 0)} registered
                </div>
                <div class="limit-editor">
                  <label>
                    Start
                    <input type="time" value="${timeValue(s.start_time)}" data-start-edit="${s.schedule_id}" />
                  </label>
                  <label>
                    End
                    <input type="time" value="${timeValue(s.end_time)}" data-end-edit="${s.schedule_id}" />
                  </label>
                  <label>
                    Min
                    <input type="number" min="0" value="${Number(s.min_participants)}" data-min-edit="${s.schedule_id}" />
                  </label>
                  <label>
                    Max
                    <input type="number" min="1" value="${Number(s.max_participants)}" data-max-edit="${s.schedule_id}" />
                  </label>
                  <span class="meta autosave-state is-saved" data-save-state="${s.schedule_id}">Saved</span>
                </div>
              </div>
              <div class="admin-time-actions">
                <span class="badge ${s.status === 'open' ? 'open' : 'full'}">${escapeHtml(s.status)}</span>
                <button class="btn btn-secondary" data-toggle="${s.schedule_id}" data-status="${nextStatus}">
                  Mark ${nextStatus}
                </button>
                <button class="btn btn-danger" data-delete-session="${s.schedule_id}">Delete</button>
              </div>
            </div>`;
            })
            .join('')
        : `<p class="meta day-empty">No times set for ${escapeHtml(day)}</p>`;

      return `
        <article class="session day-card ${slots.length ? '' : 'day-card-empty'}">
          <div class="session-top">
            <h3>${escapeHtml(day)}</h3>
            <span class="badge ${slots.length ? 'open' : 'full'}">${slots.length} time${slots.length === 1 ? '' : 's'}</span>
          </div>
          <div class="day-times">${timesHtml}</div>
        </article>`;
    }).join('');

    cards.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener(
        'click',
        onceAsync(async () => {
          const nextStatus = btn.dataset.status;
          const ok = await confirmAction({
            title: nextStatus === 'open' ? 'Open this slot?' : 'Close this slot?',
            message:
              nextStatus === 'open'
                ? 'Students will be able to register for this session (while registration is open).'
                : 'Students will no longer be able to register for this session.',
            confirmLabel: nextStatus === 'open' ? 'Open slot' : 'Close slot',
          });
          if (!ok) return;

          setBusyButton(btn, true, 'Updating…');
          try {
            await Busy.run(async () => {
              if (dirtySchedules.size && !(await saveAllSchedules({ quiet: true }))) {
                throw new Error('Save pending edits before changing slot status.');
              }
              await API.request(`/admin/schedules/${btn.dataset.toggle}/status`, {
                method: 'PATCH',
                body: { status: nextStatus },
              });
              await loadSchedules();
              await loadOverview();
            }, 'Updating slot status…');
            showAlert(alertEl, `Slot marked ${nextStatus}`, 'ok');
          } catch (err) {
            showAlert(alertEl, err.message);
          } finally {
            setBusyButton(btn, false);
          }
        })
      );
    });

    // Seed baselines from rendered values so undo has a real "before" state
    for (const s of data.schedules) {
      const state = readScheduleState(s.schedule_id);
      if (state) editBaselines.set(String(s.schedule_id), { ...state });
    }

    cards.querySelectorAll('.limit-editor input').forEach((input) => {
      const id = String(
        input.dataset.startEdit ||
          input.dataset.endEdit ||
          input.dataset.minEdit ||
          input.dataset.maxEdit ||
          ''
      );
      if (!id) return;
      const day = input.closest('[data-schedule-day]')?.dataset.scheduleDay;
      if (!day) return;

      const captureBaseline = () => {
        if (applyingHistory) return;
        // Only capture if we don't already have one for this edit session
        if (!editBaselines.has(id)) {
          const state = readScheduleState(id);
          if (state) editBaselines.set(id, { ...state });
        }
      };

      input.addEventListener('pointerdown', captureBaseline);
      input.addEventListener('focus', captureBaseline);
      input.addEventListener('keydown', captureBaseline);

      input.addEventListener('input', () => {
        if (applyingHistory) return;
        captureBaseline();
        markScheduleDirty(id, day);
        queueHistoryCommit(id);
        queueAutoSave(id);
      });

      input.addEventListener('change', () => {
        if (applyingHistory) return;
        commitHistory(id);
        markScheduleDirty(id, day);
        queueAutoSave(id);
      });

      input.addEventListener('blur', () => {
        if (applyingHistory) return;
        commitHistory(id);
      });
    });

    cards.querySelectorAll('[data-delete-session]').forEach((btn) => {
      btn.addEventListener(
        'click',
        onceAsync(async () => {
          const id = btn.dataset.deleteSession;
          const ok = await confirmAction({
            title: 'Delete session?',
            message: 'Delete this session? This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;

          setBusyButton(btn, true, 'Deleting…');
          try {
            await Busy.run(async () => {
              if (dirtySchedules.size && !(await saveAllSchedules({ quiet: true }))) {
                throw new Error('Save pending edits before deleting this session.');
              }
              await API.request(`/admin/schedules/${id}`, { method: 'DELETE' });
              await Promise.all([loadSchedules(), loadOverview()]);
            }, 'Deleting session…');
            showAlert(alertEl, 'Session deleted', 'ok');
          } catch (err) {
            showAlert(alertEl, err.message);
          } finally {
            setBusyButton(btn, false);
          }
        })
      );
    });

    updateSaveUi();
  }

  let allRegistrations = [];
  let regsDayFilter = 'all';
  let regsProgramFilter = 'all';
  let regsSort = 'name';
  let regsGroupBy = 'auto';
  let regsSearchName = '';
  let regsSearchIndex = '';

  function alphaCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  }

  function programRank(group) {
    const code = String(group || '').split('/')[1] || '';
    const idx = PROGRAM_LIST.findIndex((p) => p.code === code);
    return idx === -1 ? 99 : idx;
  }

  function regProgramGroup(r) {
    return programGroupFromIndex(r.index_number);
  }

  function initProgramFilters() {
    const container = document.getElementById('regs-program-filters');
    if (!container || container.dataset.ready) return;
    container.dataset.ready = '1';
    container.innerHTML = [
      `<button class="btn btn-secondary active" type="button" data-regs-program="all">All programmes</button>`,
      ...PROGRAM_LIST.map(
        (p) =>
          `<button class="btn btn-secondary" type="button" data-regs-program="${FACULTY_CODE}/${p.code}">PS/${p.code}</button>`
      ),
    ].join('');
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-regs-program]');
      if (!btn) return;
      regsProgramFilter = btn.dataset.regsProgram;
      container.querySelectorAll('[data-regs-program]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderRegistrations();
    });
  }

  function dayRank(day) {
    const idx = DAY_ORDER.indexOf(day);
    return idx === -1 ? 99 : idx;
  }

  function compareRegistrations(a, b, sortKey) {
    switch (sortKey) {
      case 'program':
        return (
          programRank(regProgramGroup(a)) - programRank(regProgramGroup(b)) ||
          dayRank(a.day_of_week) - dayRank(b.day_of_week) ||
          String(a.start_time).localeCompare(String(b.start_time)) ||
          alphaCompare(a.full_name, b.full_name)
        );
      case 'program-desc':
        return (
          programRank(regProgramGroup(b)) - programRank(regProgramGroup(a)) ||
          dayRank(b.day_of_week) - dayRank(a.day_of_week) ||
          String(b.start_time).localeCompare(String(a.start_time)) ||
          alphaCompare(b.full_name, a.full_name)
        );
      case 'day':
        return (
          dayRank(a.day_of_week) - dayRank(b.day_of_week) ||
          String(a.start_time).localeCompare(String(b.start_time)) ||
          alphaCompare(a.full_name, b.full_name)
        );
      case 'day-desc':
        return (
          dayRank(b.day_of_week) - dayRank(a.day_of_week) ||
          String(b.start_time).localeCompare(String(a.start_time)) ||
          alphaCompare(b.full_name, a.full_name)
        );
      case 'time':
        return (
          String(a.start_time).localeCompare(String(b.start_time)) ||
          dayRank(a.day_of_week) - dayRank(b.day_of_week) ||
          alphaCompare(a.full_name, b.full_name)
        );
      case 'time-desc':
        return (
          String(b.start_time).localeCompare(String(a.start_time)) ||
          dayRank(b.day_of_week) - dayRank(a.day_of_week) ||
          alphaCompare(b.full_name, a.full_name)
        );
      case 'name':
        return alphaCompare(a.full_name, b.full_name) || alphaCompare(a.index_number, b.index_number);
      case 'name-desc':
        return alphaCompare(b.full_name, a.full_name) || alphaCompare(b.index_number, a.index_number);
      case 'index':
        return alphaCompare(a.index_number, b.index_number) || alphaCompare(a.full_name, b.full_name);
      case 'index-desc':
        return alphaCompare(b.index_number, a.index_number) || alphaCompare(b.full_name, a.full_name);
      case 'registered':
        return new Date(b.registered_at) - new Date(a.registered_at) || alphaCompare(a.full_name, b.full_name);
      case 'registered-desc':
        return new Date(a.registered_at) - new Date(b.registered_at) || alphaCompare(a.full_name, b.full_name);
      case 'amount':
        return Number(a.amount) - Number(b.amount) || alphaCompare(a.full_name, b.full_name);
      case 'amount-desc':
        return Number(b.amount) - Number(a.amount) || alphaCompare(a.full_name, b.full_name);
      case 'phone':
        return alphaCompare(a.phone_number, b.phone_number) || alphaCompare(a.full_name, b.full_name);
      case 'phone-desc':
        return alphaCompare(b.phone_number, a.phone_number) || alphaCompare(b.full_name, a.full_name);
      default:
        return alphaCompare(a.full_name, b.full_name);
    }
  }

  function effectiveGroupMode() {
    if (regsGroupBy !== 'auto') return regsGroupBy;
    if (regsSort.startsWith('program')) return 'program';
    if (regsSort.startsWith('day') || regsSort.startsWith('time')) return 'day';
    return 'flat';
  }

  function matchesName(r, query) {
    if (!query) return true;
    const name = String(r.full_name || '').toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((term) => name.includes(term));
  }

  function matchesIndex(r, query) {
    if (!query) return true;
    return String(r.index_number || '').toLowerCase().includes(query.toLowerCase().trim());
  }

  function getFilteredRegistrations() {
    return allRegistrations
      .filter((r) => regsDayFilter === 'all' || r.day_of_week === regsDayFilter)
      .filter((r) => regsProgramFilter === 'all' || regProgramGroup(r) === regsProgramFilter)
      .filter((r) => matchesName(r, regsSearchName))
      .filter((r) => matchesIndex(r, regsSearchIndex))
      .slice()
      .sort((a, b) => compareRegistrations(a, b, regsSort));
  }

  function registrationRowHtml(r) {
    const group = regProgramGroup(r);
    return `
      <div class="day-time-row admin-reg-row">
        <div>
          <div class="admin-reg-name">${escapeHtml(r.full_name)}</div>
          <div class="meta admin-reg-program">${escapeHtml(group)} · ${escapeHtml(programLabelFromIndex(r.index_number))}</div>
        </div>
        <div class="admin-reg-index">${escapeHtml(r.index_number)}</div>
        <div>
          <span class="day-time">${escapeHtml(r.day_of_week || '—')} · ${formatTime(r.start_time)} – ${formatTime(r.end_time)}</span>
        </div>
        <div class="meta">${escapeHtml(r.phone_number || '—')} · GHS ${Number(r.amount).toFixed(2)}</div>
        <div class="meta">${formatDate(r.registered_at)}</div>
      </div>`;
  }

  function renderGroupedCards(groups, emptyLabel) {
    return groups
      .map(({ title, subtitle, rows }) => {
        if (!rows.length) {
          return `
            <article class="session day-card day-card-empty">
              <div class="session-top">
                <h3>${escapeHtml(title)}</h3>
                <span class="badge full">0 registered</span>
              </div>
              <p class="meta day-empty">${escapeHtml(subtitle || emptyLabel)}</p>
            </article>`;
        }
        return `
          <article class="session day-card">
            <div class="session-top">
              <h3>${escapeHtml(title)}</h3>
              <span class="badge open">${rows.length} registered</span>
            </div>
            ${subtitle ? `<p class="meta" style="margin:0 0 0.75rem;">${escapeHtml(subtitle)}</p>` : ''}
            <div class="day-times">${rows.map(registrationRowHtml).join('')}</div>
          </article>`;
      })
      .join('');
  }

  function renderRegistrations() {
    const container = $('admin-regs-cards');
    const summary = $('regs-summary');
    const tableHead = $('admin-regs-table-head');
    if (!container || !summary) return;

    const filtered = getFilteredRegistrations();
    const groupMode = effectiveGroupMode();

    const programLabel =
      regsProgramFilter === 'all'
        ? 'all programmes'
        : `${regsProgramFilter} (${programLabelFromIndex(`${regsProgramFilter}/22/001`)})`;
    const dayLabel = regsDayFilter === 'all' ? 'all days' : regsDayFilter;
    const nameLabel = regsSearchName.trim() ? ` · name “${regsSearchName.trim()}”` : '';
    const indexLabel = regsSearchIndex.trim() ? ` · index “${regsSearchIndex.trim()}”` : '';
    const sortLabel = $('regs-sort')?.selectedOptions?.[0]?.textContent || regsSort;

    summary.textContent = `${filtered.length} registration${filtered.length === 1 ? '' : 's'} · ${programLabel} · ${dayLabel}${nameLabel}${indexLabel} · sorted by ${sortLabel}`;
    tableHead?.classList.toggle('hidden', groupMode !== 'flat' || !filtered.length);

    if (!filtered.length) {
      container.innerHTML = `<p class="meta day-empty">No registrations match these filters.</p>`;
      return;
    }

    if (groupMode === 'flat') {
      container.innerHTML = `
        <article class="session day-card">
          <div class="session-top">
            <h3>All matching</h3>
            <span class="badge open">${filtered.length} registered</span>
          </div>
          <div class="day-times">${filtered.map(registrationRowHtml).join('')}</div>
        </article>`;
      return;
    }

    if (groupMode === 'day') {
      const daysToShow = regsDayFilter === 'all' ? DAY_ORDER : [regsDayFilter];
      container.innerHTML = renderGroupedCards(
        daysToShow.map((day) => ({
          title: day,
          subtitle: null,
          rows: filtered.filter((r) => (r.day_of_week || 'Monday') === day),
        })),
        'No registrations'
      );
      return;
    }

    const programsToShow =
      regsProgramFilter === 'all'
        ? PROGRAM_LIST.map((p) => ({ group: `${FACULTY_CODE}/${p.code}`, label: p.label }))
        : [{ group: regsProgramFilter, label: programLabelFromIndex(`${regsProgramFilter}/22/001`) }];

    container.innerHTML = renderGroupedCards(
      programsToShow.map(({ group, label }) => ({
        title: group,
        subtitle: label,
        rows: filtered.filter((r) => regProgramGroup(r) === group),
      })),
      'no registrations'
    );
  }

  async function loadRegistrations() {
    initProgramFilters();
    const data = await API.request('/admin/registrations');
    allRegistrations = data.registrations;
    renderRegistrations();
  }

  document.getElementById('regs-day-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-regs-day]');
    if (!btn) return;
    regsDayFilter = btn.dataset.regsDay;
    document.querySelectorAll('[data-regs-day]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderRegistrations();
  });

  document.getElementById('regs-sort').addEventListener('change', (e) => {
    regsSort = e.target.value;
    renderRegistrations();
  });

  document.getElementById('regs-group').addEventListener('change', (e) => {
    regsGroupBy = e.target.value;
    renderRegistrations();
  });

  document.getElementById('regs-search-name').addEventListener('input', (e) => {
    regsSearchName = e.target.value || '';
    renderRegistrations();
  });

  document.getElementById('regs-search-index').addEventListener('input', (e) => {
    regsSearchIndex = e.target.value || '';
    renderRegistrations();
  });

  document.getElementById('regs-clear-filters').addEventListener('click', () => {
    regsDayFilter = 'all';
    regsProgramFilter = 'all';
    regsSort = 'name';
    regsGroupBy = 'auto';
    regsSearchName = '';
    regsSearchIndex = '';
    document.getElementById('regs-search-name').value = '';
    document.getElementById('regs-search-index').value = '';
    document.getElementById('regs-sort').value = 'name';
    document.getElementById('regs-group').value = 'auto';
    document.querySelectorAll('[data-regs-day]').forEach((b) => {
      b.classList.toggle('active', b.dataset.regsDay === 'all');
    });
    document.querySelectorAll('[data-regs-program]').forEach((b) => {
      b.classList.toggle('active', b.dataset.regsProgram === 'all');
    });
    renderRegistrations();
  });

  document.getElementById('btn-open-reg').addEventListener(
    'click',
    onceAsync(async () => {
      const ok = await confirmAction({
        title: 'Open registration?',
        message: 'Students who have paid via Paystack will be able to book open sessions.',
        confirmLabel: 'Open registration',
      });
      if (!ok) return;
      const btn = document.getElementById('btn-open-reg');
      setBusyButton(btn, true, 'Opening…');
      try {
        await Busy.run(async () => {
          await API.request('/admin/settings/registration', { method: 'PATCH', body: { open: true } });
          await loadOverview();
        }, 'Opening registration…');
        showAlert(alertEl, 'Registration is now open', 'ok');
      } catch (err) {
        showAlert(alertEl, err.message);
      } finally {
        setBusyButton(btn, false);
      }
    })
  );

  document.getElementById('btn-close-reg').addEventListener(
    'click',
    onceAsync(async () => {
      const ok = await confirmAction({
        title: 'Close registration?',
        message: 'Students will not be able to book or switch sessions until you open registration again.',
        confirmLabel: 'Close registration',
        danger: true,
      });
      if (!ok) return;
      const btn = document.getElementById('btn-close-reg');
      setBusyButton(btn, true, 'Closing…');
      try {
        await Busy.run(async () => {
          await API.request('/admin/settings/registration', { method: 'PATCH', body: { open: false } });
          await loadOverview();
        }, 'Closing registration…');
        showAlert(alertEl, 'Registration is now closed', 'info');
      } catch (err) {
        showAlert(alertEl, err.message);
      } finally {
        setBusyButton(btn, false);
      }
    })
  );

  document.getElementById('schedule-form').addEventListener(
    'submit',
    onceAsync(async (e) => {
      e.preventDefault();
      hideAlert(alertEl);
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      const fd = new FormData(form);

      lockControls(form, true);
      setBusyButton(submitBtn, true, 'Saving…');
      try {
        await Busy.run(async () => {
          if (dirtySchedules.size && !(await saveAllSchedules({ quiet: true }))) {
            throw new Error('Save pending edits before creating a new slot.');
          }
          await API.request('/admin/schedules', {
            method: 'POST',
            body: {
              day_of_week: fd.get('day_of_week'),
              start_time: fd.get('start_time'),
              end_time: fd.get('end_time'),
              min_participants: Number(fd.get('min_participants')),
              max_participants: Number(fd.get('max_participants')),
            },
          });
          form.reset();
          await Promise.all([loadSchedules(), loadOverview()]);
        }, 'Creating day/time slot…');
        showAlert(alertEl, 'Day/time slot saved', 'ok');
      } catch (err) {
        showAlert(alertEl, err.message);
      } finally {
        lockControls(form, false);
        setBusyButton(submitBtn, false);
      }
    })
  );

  bindClick(
    'save-all-schedules',
    onceAsync(async (e) => {
      e.preventDefault();
      try {
        await saveAllSchedules();
      } catch (err) {
        showAlert(alertEl, err.message);
      }
    })
  );
  bindClick('undo-schedules', (e) => {
    e.preventDefault();
    undoEdit();
  });
  bindClick('redo-schedules', (e) => {
    e.preventDefault();
    redoEdit();
  });

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const tag = String(event.target?.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    // Allow undo/redo shortcuts even while editing schedule fields
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undoEdit();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redoEdit();
    } else if (key === 's') {
      event.preventDefault();
      if (document.body.classList.contains('is-busy')) return;
      saveAllSchedules().catch((err) => showAlert(alertEl, err.message));
    } else if (inField) {
      return;
    }
  });

  updateSaveUi();

  window.addEventListener('beforeunload', (event) => {
    if (allowNavigation || (!dirtySchedules.size && !activeSaves)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  (async () => {
    try {
      await Promise.all([loadOverview(), loadSchedules(), loadRegistrations()]);
    } catch (err) {
      showAlert(alertEl, err.message + ' — check DATABASE_URL and that schema/seed have been run.');
    }
  })();
})();
