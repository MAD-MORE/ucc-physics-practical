/**
 * DOM-first Paystack integration.
 * - Hydrates [data-paystack-*] nodes from the API
 * - Collects email/phone/amount/key from the form DOM
 * - Opens Paystack Inline Popup, then verifies on the server
 */
const PaystackCheckout = {
  scriptUrl: 'https://js.paystack.co/v1/inline.js',
  scriptPromise: null,
  formSelector: '[data-paystack-form], #payment-modal-form',

  escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  $(sel, root = document) {
    return root.querySelector(sel);
  },

  $$(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  },

  resolveForm(formOrSelector) {
    if (formOrSelector instanceof HTMLFormElement) return formOrSelector;
    if (typeof formOrSelector === 'string') return this.$(formOrSelector);
    return this.$(this.formSelector);
  },

  field(form, name) {
    const byName = form.elements?.namedItem?.(name);
    if (byName) return byName.length != null ? byName[0] : byName;
    return (
      form.querySelector(`[name="${name}"]`) ||
      form.querySelector(`[data-paystack-field="${name}"]`) ||
      form.querySelector(`#modal-${name === 'phone_number' ? 'phone' : name}`)
    );
  },

  setText(sel, text, root = document) {
    this.$$(sel, root).forEach((el) => {
      el.textContent = text;
    });
  },

  ensureHidden(form, name, value) {
    let input = form.querySelector(`input[name="${name}"][data-paystack-sync]`);
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.dataset.paystackSync = '1';
      form.appendChild(input);
    }
    input.value = value == null ? '' : String(value);
    return input;
  },

  /** Allowed MoMo networks on the frontend (server also enforces). */
  allowedMomoProviders: ['mtn'],

  lockMomoProvider(form) {
    const providerEl = this.field(form, 'provider');
    if (!providerEl) return 'mtn';

    [...(providerEl.options || [])].forEach((opt) => {
      const code = String(opt.value || '').toLowerCase();
      const allowed = this.allowedMomoProviders.includes(code);
      opt.disabled = !allowed;
      if (!allowed && opt.value) {
        if (!/blocked/i.test(opt.textContent)) {
          opt.textContent = `${opt.textContent.replace(/\s*—\s*blocked.*/i, '').trim()} — blocked for now`;
        }
      }
    });

    if (!this.allowedMomoProviders.includes(String(providerEl.value || '').toLowerCase())) {
      providerEl.value = 'mtn';
    }
    return String(providerEl.value || 'mtn').toLowerCase();
  },

  /** Read payer + checkout fields from the form DOM. */
  collectDetails(formOrSelector) {
    const form = this.resolveForm(formOrSelector);
    if (!form) throw new Error('Payment form not found in the DOM');

    const emailEl = this.field(form, 'email');
    const phoneEl = this.field(form, 'phone_number');
    const providerEl = this.field(form, 'provider');
    const methodEl = form.querySelector('[name="pay_method"]:checked') || this.field(form, 'pay_method');
    const email = String(emailEl?.value || '').trim();
    const phone_number = String(phoneEl?.value || '').trim();
    const provider = this.lockMomoProvider(form);
    const method = String(methodEl?.value || 'momo').trim().toLowerCase();

    if (!email) {
      emailEl?.focus();
      throw new Error('Enter the email for your Paystack receipt');
    }
    if (emailEl?.checkValidity && !emailEl.checkValidity()) {
      emailEl.reportValidity();
      throw new Error('Enter a valid email for Paystack');
    }

    if (method === 'momo') {
      if (!phone_number || phone_number.length < 10) {
        phoneEl?.focus();
        throw new Error('Enter the MoMo number that will receive the PIN prompt');
      }
      if (!this.allowedMomoProviders.includes(provider)) {
        providerEl?.focus();
        throw new Error('ATMoney and Telecel are blocked. Use MTN MoMo, bank transfer, or card.');
      }
    }

    return {
      form,
      email,
      phone_number,
      provider: 'mtn',
      method,
      public_key: form.dataset.paystackPublicKey || this.field(form, 'public_key')?.value || '',
      currency: form.dataset.paystackCurrency || this.field(form, 'currency')?.value || 'GHS',
      amount_pesewas: Number(form.dataset.paystackAmountPesewas || this.field(form, 'amount')?.value || 0),
      fee: Number(form.dataset.paystackFee || 0),
      mock: form.dataset.paystackMock === '1',
    };
  },

  /** Write API config into DOM nodes and hidden inputs. */
  applyConfigToDom(config, form) {
    const root = form?.closest('[data-paystack-root]') || document;
    const feeLabel = `GHS ${Number(config.fee).toFixed(0)}`;
    const live = Boolean(config.public_key && String(config.public_key).includes('_live_'));
    const modeLabel = config.mock
      ? 'Paystack is not configured — set live keys in .env'
      : live
        ? 'Live · MoMo, bank transfer, or card'
        : 'TEST keys · real wallets will NOT be charged';

    this.setText('[data-paystack-fee]', feeLabel, root);
    this.setText('[data-paystack-mode]', modeLabel, root);

    const hint = root.querySelector('[data-paystack-test-hint]');
    if (hint) {
      if (config.mock) {
        hint.classList.add('hidden');
      } else if (live) {
        hint.classList.remove('hidden');
        hint.textContent =
          'After you pay, your phone opens a Reply screen: Enter MM PIN — type your MoMo PIN there, not on this website.';
      } else {
        hint.classList.remove('hidden');
        hint.textContent =
          'TEST keys cannot debit real MoMo. Put LIVE keys in .env (pk_live_ / sk_live_).';
      }
    }

    if (!form) return config;

    form.dataset.paystackMock = config.mock ? '1' : '0';
    form.dataset.paystackCurrency = config.currency || 'GHS';
    form.dataset.paystackFee = String(config.fee ?? '');
    form.dataset.paystackAmountPesewas = String(Math.round(Number(config.fee) * 100));
    if (config.public_key) form.dataset.paystackPublicKey = config.public_key;
    else delete form.dataset.paystackPublicKey;

    this.ensureHidden(form, 'currency', config.currency || 'GHS');
    this.ensureHidden(form, 'amount', Math.round(Number(config.fee) * 100));
    this.ensureHidden(form, 'public_key', config.public_key || '');

    const submit = form.querySelector('[type="submit"], [data-paystack-pay]');
    if (submit) {
      submit.dataset.paystackReady = config.mock || config.public_key ? '1' : '0';
      if (!submit.dataset.idlePayLabel) submit.dataset.idlePayLabel = submit.textContent;
      submit.textContent = config.mock ? 'Paystack not configured' : submit.dataset.idlePayLabel || 'Pay with Paystack';
    }

    return config;
  },

  async hydrateForm(formOrSelector) {
    const form = this.resolveForm(formOrSelector);
    if (!form) return null;
    const config = await API.request('/student/payments/config');
    this.applyConfigToDom(config, form);
    this.bindPayMethodToggle(form);
    return config;
  },

  bindPayMethodToggle(form) {
    if (!form || form.dataset.payMethodBound === '1') return;
    form.dataset.payMethodBound = '1';
    this.lockMomoProvider(form);

    const sync = () => {
      const method =
        form.querySelector('[name="pay_method"]:checked')?.value ||
        form.querySelector('[name="pay_method"]')?.value ||
        'momo';
      const momoOnly = method === 'momo';
      form.querySelectorAll('[data-momo-only]').forEach((el) => {
        el.classList.toggle('hidden', !momoOnly);
        el.querySelectorAll('input, select').forEach((input) => {
          if (momoOnly) input.setAttribute('required', 'required');
          else input.removeAttribute('required');
        });
      });
      this.lockMomoProvider(form);
      const submit = form.querySelector('[data-paystack-pay], button[type="submit"]');
      if (submit) {
        if (!submit.dataset.idlePayLabel) submit.dataset.idlePayLabel = submit.textContent;
        submit.textContent =
          method === 'momo'
            ? 'Send MTN PIN prompt'
            : method === 'bank'
              ? 'Open bank transfer'
              : 'Pay with card';
      }
    };

    form.querySelectorAll('[name="pay_method"]').forEach((el) => {
      el.addEventListener('change', sync);
    });
    form.querySelectorAll('[name="provider"]').forEach((el) => {
      el.addEventListener('change', () => {
        this.lockMomoProvider(form);
      });
    });
    sync();
  },

  /** Hydrate every Paystack form currently in the DOM. */
  async hydrateAll() {
    const forms = this.$$('[data-paystack-form], #payment-modal-form');
    if (!forms.length) return [];
    const config = await API.request('/student/payments/config');
    return forms.map((form) => {
      this.applyConfigToDom(config, form);
      this.bindPayMethodToggle(form);
      return config;
    });
  },

  loadScript() {
    if (window.PaystackPop) return Promise.resolve();
    if (this.scriptPromise) return this.scriptPromise;

    const existing = this.$('script[data-paystack-inline]');
    if (existing) {
      this.scriptPromise = new Promise((resolve, reject) => {
        if (window.PaystackPop) return resolve();
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load Paystack')));
      });
      return this.scriptPromise;
    }

    this.scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = this.scriptUrl;
      script.async = true;
      script.dataset.paystackInline = '1';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Paystack checkout'));
      document.head.appendChild(script);
    });
    return this.scriptPromise;
  },

  openPopupFromDom(details, init) {
    const publicKey = init.public_key || details.public_key;
    if (!publicKey) throw new Error('Paystack public key missing from the DOM / API');

    const email = init.email || details.email;
    const amount = init.amount_pesewas || details.amount_pesewas;
    const currency = init.currency || details.currency || 'GHS';
    const channels = init.channels || ['mobile_money', 'card'];
    const reference = init.reference;
    const accessCode = init.access_code;

    details.form.dataset.paystackReference = reference;
    this.ensureHidden(details.form, 'reference', reference);
    if (accessCode) this.ensureHidden(details.form, 'access_code', accessCode);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      // Preferred Paystack Popup flow: resume with access_code from initialize
      if (accessCode && typeof PaystackPop === 'function') {
        try {
          const popup = new PaystackPop();
          if (typeof popup.resumeTransaction === 'function') {
            popup.resumeTransaction(accessCode, {
              onSuccess(transaction) {
                finish(resolve, {
                  reference: transaction?.reference || reference,
                  status: transaction?.status,
                });
              },
              onCancel() {
                finish(reject, new Error('Payment window closed before completion'));
              },
              onError(error) {
                finish(reject, new Error(error?.message || 'Paystack checkout failed'));
              },
            });
            return;
          }
        } catch {
          // fall through to legacy setup()
        }
      }

      const handler = PaystackPop.setup({
        key: publicKey,
        email,
        amount,
        currency,
        ref: reference,
        channels,
        metadata: {
          custom_fields: [
            {
              display_name: 'Email',
              variable_name: 'email',
              value: email,
            },
            {
              display_name: 'Phone',
              variable_name: 'phone_number',
              value: details.phone_number || '',
            },
          ],
        },
        callback(response) {
          finish(resolve, response);
        },
        onClose() {
          finish(reject, new Error('Payment window closed before completion'));
        },
      });
      handler.openIframe();
    });
  },

  /** If Paystack redirected back with ?reference= / ?trxref=, verify via API. */
  async completeReturnFromQuery(search = window.location.search) {
    const params = new URLSearchParams(search);
    const reference = params.get('reference') || params.get('trxref');
    if (!reference) return null;
    return API.request('/student/payments/verify', {
      method: 'POST',
      body: { reference },
    });
  },

  showOtpStep() {
    // Website voucher/OTP disabled while MTN-only — approval is on the phone
    return null;
  },

  hideOtpStep(root) {
    const payForm = root?.querySelector('[data-paystack-form]');
    const otpForm = root?.querySelector('[data-paystack-otp-form]');
    otpForm?.classList.add('hidden');
    if (otpForm) otpForm.style.display = 'none';
    if (payForm) {
      payForm.classList.remove('hidden');
      payForm.style.display = '';
      payForm.querySelectorAll('input, select, button').forEach((el) => {
        if (el.dataset.lockOwned === '1') return;
        el.disabled = false;
      });
    }
  },

  waitForOtpSubmission() {
    return Promise.reject(
      new Error('Website voucher/OTP is disabled. Approve with your MTN MoMo PIN on the phone.')
    );
  },

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /** Poll verify until success/fail or timeout (MoMo phone approval). */
  async waitForMomoApproval(reference, { seconds = 180, onTick, root } = {}) {
    const deadline = Date.now() + seconds * 1000;
    let lastError = null;
    // Never open website OTP/voucher while waiting — MTN PIN/USSD happens on the handset
    this.hideOtpStep(root);
    while (Date.now() < deadline) {
      try {
        const result = await API.request('/student/payments/verify', {
          method: 'POST',
          body: { reference },
        });
        if (result.payment || result.status === 'success') {
          return result;
        }
        if (result.pending) {
          if (typeof onTick === 'function') {
            onTick(
              result.message ||
                'Waiting on your phone — enter your MTN MoMo PIN when prompted (not a website code).'
            );
          }
          await this.sleep(3000);
          continue;
        }
      } catch (err) {
        lastError = err;
        const msg = String(err.message || '');
        // Brief race: charge just created / reference syncing — keep waiting a bit
        if (/payment not found/i.test(msg) && Date.now() + 9000 < deadline) {
          if (typeof onTick === 'function') onTick('Confirming payment…');
          await this.sleep(3000);
          continue;
        }
        throw err;
      }
      await this.sleep(3000);
    }
    throw lastError || new Error('Timed out waiting for MoMo approval on your phone');
  },

  /**
   * MoMo → Charge API → PIN/USSD on the phone only (no website voucher).
   * Bank transfer / card → Paystack Popup.
   */
  async pay(formOrSelector) {
    const details = this.collectDetails(formOrSelector);
    const { form, email, phone_number, provider, method } = details;
    const root = form.closest('[data-paystack-root]') || document;
    this.hideOtpStep(root);

    if (method === 'momo') {
      const charged = await Busy.run(
        () =>
          API.request('/student/payments/momo', {
            method: 'POST',
            body: { email, phone_number, provider: 'mtn' },
          }),
        'Sending MTN MoMo PIN prompt…'
      );

      form.dataset.paystackReference = charged.reference || charged.payment?.paystack_reference || '';
      this.ensureHidden(form, 'reference', form.dataset.paystackReference);

      if (charged.already_paid || charged.mock || charged.status === 'success' || charged.payment) {
        return charged;
      }

      // Always wait on the handset for MTN — the MM PIN Reply dialog is on the phone
      this.hideOtpStep(root);
      const waitEl = root.querySelector('[data-paystack-wait]');
      const pinHint =
        charged.display_text ||
        `Watch ${phone_number}: MTN will show a Reply screen — “Enter MM PIN”. Type your MoMo PIN on the phone and tap Reply. Do not type a code here.`;
      if (waitEl) {
        waitEl.classList.remove('hidden');
        waitEl.innerHTML = `<strong>Phone prompt sent.</strong> ${this.escapeHtml(pinHint)}`;
      }
      try {
        return await this.waitForMomoApproval(charged.reference, {
          seconds: charged.poll_seconds || 180,
          root,
          onTick(msg) {
            if (waitEl && msg) {
              waitEl.innerHTML = `<strong>Waiting for your MM PIN…</strong> ${PaystackCheckout.escapeHtml(msg)}`;
            }
          },
        });
      } finally {
        waitEl?.classList.add('hidden');
        this.hideOtpStep(root);
      }
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

  /** Wire submit handlers for all Paystack forms found in the DOM. */
  bindForms(handler) {
    this.$$('[data-paystack-form], #payment-modal-form').forEach((form) => {
      if (form.dataset.paystackBound === '1') return;
      form.dataset.paystackBound = '1';
      form.addEventListener('submit', (event) => handler(event, form));
    });
  },
};

// Prefetch Inline.js into the DOM early when this file loads
if (document.head) {
  PaystackCheckout.loadScript().catch(() => {});
}
