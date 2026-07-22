(function () {
  const user = requireRole('student', '/');
  if (!user) return;

  const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  setText('user-chip', `${user.full_name} · ${user.index_number}${user.level ? ` · L${user.level}` : ''}`);
  bindClick('logout-btn', () => {
    API.clearSession();
    window.location.href = '/';
  });

  const alertEl = $('page-alert');
  const paymentModal = $('payment-modal');
  const paymentAlert = $('payment-modal-alert');
  let paymentReady = false;
  let registrationOpen = false;
  let hasBooking = false;
  let canChangeBooking = false;
  let currentBooking = null;
  let openSessionCount = 0;
  let actionLocked = false;

  function openPaymentModal() {
    if (actionLocked) return;
    hideAlert(paymentAlert);
    paymentModal?.classList.remove('hidden');
    delete paymentModal?.dataset.busyLock;
    const emailEl = $('modal-email');
    if (emailEl && user?.email && !emailEl.value) emailEl.value = user.email;
    PaystackCheckout.hydrateForm('payment-modal-form').catch(() => {});
    emailEl?.focus();
  }

  function closePaymentModal() {
    if (paymentModal?.dataset.busyLock) return;
    paymentModal?.classList.add('hidden');
    $('payment-modal-form')?.reset();
    hideAlert(paymentAlert);
  }

  function setSessionActionsLocked(locked) {
    document.querySelectorAll('.session-action-btn').forEach((btn) => {
      if (locked) {
        btn.dataset.wasDisabled = btn.disabled ? '1' : '0';
        btn.disabled = true;
      } else if (btn.dataset.wasDisabled != null) {
        btn.disabled = btn.dataset.wasDisabled === '1';
        delete btn.dataset.wasDisabled;
      }
    });
  }

  function sessionButtonState(session) {
    if (hasBooking && session.change) {
      return {
        disabled: session.change.disabled,
        label: session.change.label,
        action: session.change.state === 'switch' ? 'change' : 'none',
      };
    }

    const full = Number(session.registration_count || 0) >= Number(session.max_participants || 0);
    if (!paymentReady) return { disabled: true, label: 'Pay first', action: 'none' };
    if (!registrationOpen) return { disabled: true, label: 'Closed', action: 'none' };
    if (full) return { disabled: true, label: 'Full', action: 'none' };
    return { disabled: false, label: 'Register', action: 'register' };
  }

  function updatePortalMessage() {
    const lede = $('status-lede');
    if (!lede) return;
    if (hasBooking && canChangeBooking) {
      lede.textContent =
        'You have one booking. Pick another open session with space left to switch — changes lock when your session time arrives.';
      return;
    }
    if (hasBooking) {
      lede.textContent =
        currentBooking?.blocked_reason ||
        'Your booking is locked. You cannot change it after the session time or when registration is closed.';
      return;
    }
    if (!registrationOpen) {
      lede.textContent = 'Registration is closed by the department. You can still pay with Paystack and wait for it to reopen.';
      return;
    }
    if (!openSessionCount) {
      lede.textContent = 'Registration is open, but no day/time slots have been published yet.';
      return;
    }
    if (!paymentReady) {
      lede.textContent = 'Pay with Paystack to unlock registration. MoMo or card is debited straight away.';
      return;
    }
    lede.textContent = 'Pick a day and time for your practical session.';
  }

  async function loadRegistrations() {
    const tbody = $('regs-body');
    if (!tbody) return;
    try {
      const data = await API.request('/student/registrations');
      if (!data.registrations.length) {
        tbody.innerHTML = '<tr><td colspan="3">No registrations yet.</td></tr>';
        return;
      }
      tbody.innerHTML = data.registrations
        .map(
          (r) => `
        <tr>
          <td>${escapeHtml(r.day_of_week || formatDate(r.slot_date))}</td>
          <td>${formatTime(r.start_time)} – ${formatTime(r.end_time)}</td>
          <td>${escapeHtml(r.phone_number || '—')}<br><span class="meta">GHS ${Number(r.amount).toFixed(2)}</span></td>
        </tr>`
        )
        .join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="3">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function loadSessions({ quiet = false } = {}) {
    const list = $('session-list');
    if (!list) return;
    if (!quiet) list.setAttribute('aria-busy', 'true');
    try {
      const data = await API.request('/student/sessions');
      registrationOpen = data.registration_open;
      hasBooking = Boolean(data.has_booking);
      canChangeBooking = Boolean(data.can_change_booking);
      currentBooking = data.current_booking;
      paymentReady = Boolean(data.unused_payment);
      openSessionCount = Number(data.open_session_count || 0);

      setText('fee-display', Number(data.fee).toFixed(0));
      setText('reg-open-display', registrationOpen ? 'Open' : 'Closed');
      setText('sessions-display', String(openSessionCount));
      setText('payment-display', hasBooking ? 'Used' : paymentReady ? 'Yes' : 'No');

      const needsPayment = !hasBooking && !paymentReady;
      $('payment-needed')?.classList.toggle('hidden', !needsPayment);
      updatePortalMessage();
      if (!quiet) hideAlert(alertEl);

      if (hasBooking && canChangeBooking) {
        showAlert(alertEl, 'You can switch to another session while space is available and before your session time.', 'info');
      } else if (hasBooking) {
        showAlert(alertEl, currentBooking?.blocked_reason || 'Your booking cannot be changed.', 'info');
      } else if (!registrationOpen) {
        showAlert(alertEl, 'Registration is currently closed by the department.', 'info');
      } else if (!openSessionCount) {
        showAlert(alertEl, 'No day/time slots are available yet. Check back after the admin publishes them.', 'info');
      } else if (needsPayment) {
        showAlert(alertEl, 'Pay with Paystack before registering for a session.', 'info');
      }

      const byDay = {};
      for (const day of DAY_ORDER) byDay[day] = [];

      for (const s of data.sessions) {
        const day = s.day_of_week || 'Monday';
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(s);
      }

      list.innerHTML = DAY_ORDER.map((day) => {
        const slots = byDay[day]
          .slice()
          .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));

        const timesHtml = slots.length
          ? slots
              .map((s) => {
                const btn = sessionButtonState(s);
                const spotsLeft = Math.max(
                  0,
                  Number(s.spots_left ?? s.max_participants - s.registration_count)
                );
                const rowClass = btn.action === 'change' ? 'day-time-row switchable-row' : 'day-time-row';
                return `
            <div class="${rowClass}">
              <div>
                <span class="day-time">${formatTime(s.start_time)} – ${formatTime(s.end_time)}</span>
                <div class="meta">${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left</div>
              </div>
              <button
                class="btn ${btn.action === 'change' ? 'btn-secondary' : 'btn-primary'} session-action-btn"
                data-schedule="${s.schedule_id}"
                data-action="${btn.action}"
                ${btn.disabled ? 'disabled' : ''}
              >
                ${btn.label}
              </button>
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

      list.querySelectorAll('.session-action-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (actionLocked || btn.disabled) return;
          const scheduleId = Number(btn.dataset.schedule);
          if (btn.dataset.action === 'change') changeBooking(scheduleId, btn);
          else if (btn.dataset.action === 'register') registerFor(scheduleId, btn);
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    } finally {
      list.removeAttribute('aria-busy');
    }
  }

  const registerFor = onceAsync(async function registerFor(scheduleId, btn) {
    if (actionLocked) return;
    hideAlert(alertEl);
    if (hasBooking) {
      showAlert(alertEl, 'Only one booking is allowed per student.', 'info');
      return;
    }
    if (!registrationOpen) {
      showAlert(alertEl, 'Registration is currently closed by the department.', 'info');
      return;
    }
    if (!paymentReady) {
      showAlert(alertEl, 'Payment must be completed and confirmed before you can register.', 'info');
      openPaymentModal();
      return;
    }

    actionLocked = true;
    setSessionActionsLocked(true);
    try {
      const ok = await confirmAction({
        title: 'Confirm registration',
        message: 'Book this practical session? You can switch later only while space remains and before the session starts.',
        confirmLabel: 'Register',
      });
      if (!ok) return;

      setBusyButton(btn, true, 'Registering…');
      try {
        const data = await Busy.run(
          () =>
            API.request('/student/register', {
              method: 'POST',
              body: { schedule_id: scheduleId },
            }),
          'Registering your session…'
        );
        paymentReady = false;
        setText('payment-display', 'Used');
        showAlert(alertEl, data.message || 'Registration successful', 'ok');
        await Promise.all([loadSessions({ quiet: true }), loadRegistrations()]);
      } catch (err) {
        showAlert(alertEl, err.message);
        await loadSessions({ quiet: true });
      } finally {
        setBusyButton(btn, false);
      }
    } finally {
      setSessionActionsLocked(false);
      actionLocked = false;
    }
  });

  const changeBooking = onceAsync(async function changeBooking(scheduleId, btn) {
    if (actionLocked) return;
    hideAlert(alertEl);
    if (!hasBooking || !canChangeBooking) {
      showAlert(alertEl, currentBooking?.blocked_reason || 'Booking changes are not allowed right now.', 'info');
      return;
    }

    actionLocked = true;
    setSessionActionsLocked(true);
    try {
      const ok = await confirmAction({
        title: 'Switch session?',
        message: 'Move your booking to this session? You can keep only one session at a time.',
        confirmLabel: 'Switch here',
      });
      if (!ok) return;

      setBusyButton(btn, true, 'Switching…');
      try {
        const data = await Busy.run(
          () =>
            API.request('/student/booking', {
              method: 'PATCH',
              body: { schedule_id: scheduleId },
            }),
          'Updating your booking…'
        );
        showAlert(alertEl, data.message || 'Booking updated', 'ok');
        await Promise.all([loadSessions({ quiet: true }), loadRegistrations()]);
      } catch (err) {
        showAlert(alertEl, err.message);
        await loadSessions({ quiet: true });
      } finally {
        setBusyButton(btn, false);
      }
    } finally {
      setSessionActionsLocked(false);
      actionLocked = false;
    }
  });

  bindClick('open-payment-modal', openPaymentModal);
  bindClick('payment-modal-cancel', closePaymentModal);
  closeOnBackdropOrEscape(paymentModal, closePaymentModal);

  $('payment-modal-form')?.addEventListener(
    'submit',
    onceAsync(async (e) => {
      e.preventDefault();
      hideAlert(paymentAlert);
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');

      paymentModal.dataset.busyLock = '1';
      lockControls(form, true);
      setBusyButton(submitBtn, true, 'Debiting…');
      try {
        const data = await PaystackCheckout.pay(form);
        if (data.token && data.user) {
          API.setSession(data.token, data.user);
        }
        paymentReady = true;
        delete paymentModal.dataset.busyLock;
        closePaymentModal();
        showAlert(
          alertEl,
          data.message ||
            `GHS ${Number(data.payment.amount).toFixed(0)} paid via Paystack. You can register now.`,
          'ok'
        );
        await loadSessions({ quiet: true });
      } catch (err) {
        showAlert(paymentAlert, err.message);
      } finally {
        delete paymentModal.dataset.busyLock;
        lockControls(form, false);
        setBusyButton(submitBtn, false);
      }
    })
  );

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  (async () => {
    try {
      const returned = await PaystackCheckout.completeReturnFromQuery();
      if (returned?.payment) {
        paymentReady = true;
        showAlert(alertEl, returned.message || 'Paystack payment confirmed. You can register now.', 'ok');
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);
      }
    } catch (err) {
      if (new URLSearchParams(window.location.search).has('reference') ||
          new URLSearchParams(window.location.search).has('trxref')) {
        showAlert(alertEl, err.message || 'Could not confirm Paystack payment');
      }
    }
    await Promise.all([loadSessions(), loadRegistrations()]);
  })();
})();
