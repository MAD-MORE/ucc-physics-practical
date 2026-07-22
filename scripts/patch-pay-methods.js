const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'public', 'js', 'paystack-checkout.js');
let s = fs.readFileSync(file, 'utf8');

const start = s.indexOf('  /**\n   * MoMo → Paystack Popup');
const startAlt = s.indexOf('  /**\r\n   * MoMo → Paystack Popup');
const i = start >= 0 ? start : startAlt;
if (i < 0) {
  console.error('pay() marker not found');
  process.exit(1);
}
const end = s.indexOf('  /** Wire submit handlers', i);
if (end < 0) {
  console.error('bindForms marker not found');
  process.exit(1);
}

const next = `  /**
   * MoMo → realtime Charge API (PIN prompt on phone).
   * Bank transfer / card → Paystack Popup.
   */
  async pay(formOrSelector) {
    const details = this.collectDetails(formOrSelector);
    const { form, email, phone_number, provider, method } = details;
    const root = form.closest('[data-paystack-root]') || document;
    this.hideOtpStep(root);

    // Realtime MoMo PIN on the phone
    if (method === 'momo') {
      const charged = await Busy.run(
        () =>
          API.request('/student/payments/momo', {
            method: 'POST',
            body: { email, phone_number, provider },
          }),
        'Sending MoMo PIN prompt…'
      );

      form.dataset.paystackReference = charged.reference || charged.payment?.paystack_reference || '';
      this.ensureHidden(form, 'reference', form.dataset.paystackReference);

      if (charged.already_paid || charged.mock || charged.status === 'success' || charged.payment) {
        return charged;
      }

      if (charged.needs_otp || charged.status === 'send_otp') {
        return this.waitForOtpSubmission(root, charged.reference, {
          display_text: charged.display_text || charged.message,
        });
      }

      if (charged.wait_for_phone) {
        const waitEl = root.querySelector('[data-paystack-wait]');
        if (waitEl) {
          waitEl.classList.remove('hidden');
          waitEl.textContent =
            charged.display_text ||
            'Check your phone now and type your MoMo PIN to approve the payment.';
        }
        try {
          return await this.waitForMomoApproval(charged.reference, {
            seconds: charged.poll_seconds || 180,
            onTick(msg) {
              if (waitEl && msg) waitEl.textContent = msg;
            },
          });
        } finally {
          waitEl?.classList.add('hidden');
        }
      }

      return charged;
    }

    const channels = method === 'bank' ? ['bank_transfer'] : ['card'];
    const busyLabel =
      method === 'bank' ? 'Opening bank transfer…' : 'Opening card checkout…';

    const init = await Busy.run(
      () =>
        API.request('/student/payments/initialize', {
          method: 'POST',
          body: { email, phone_number, channels },
        }),
      busyLabel
    );

    form.dataset.paystackReference = init.reference || init.payment?.paystack_reference || '';
    this.ensureHidden(form, 'reference', form.dataset.paystackReference);

    if (init.already_paid || init.mock) {
      return init;
    }

    const waitEl = root.querySelector('[data-paystack-wait]');
    if (waitEl && method === 'bank') {
      waitEl.classList.remove('hidden');
      waitEl.textContent =
        'Paystack will show a bank account. Transfer the exact amount from your bank or MoMo (GIP / Instant Pay).';
    }

    try {
      await this.loadScript();
      if (!window.PaystackPop) throw new Error('Paystack checkout is unavailable in this browser');

      this.applyConfigToDom(
        {
          mock: false,
          public_key: init.public_key,
          currency: init.currency || 'GHS',
          fee: init.amount ?? details.fee,
          test_mode: init.public_key?.includes('_test_'),
        },
        form
      );

      const popupResult = await this.openPopupFromDom(details, {
        ...init,
        channels,
      });

      return Busy.run(
        () =>
          API.request('/student/payments/verify', {
            method: 'POST',
            body: { reference: popupResult.reference || init.reference },
          }),
        'Confirming payment…'
      );
    } finally {
      waitEl?.classList.add('hidden');
    }
  },

`;

fs.writeFileSync(file, s.slice(0, i) + next + s.slice(end));
console.log('Updated pay() for realtime MoMo PIN + bank transfer');
