(function () {
  'use strict';
  if (window.SixoEscrow) return;
  const labels = {creating:'Starting checkout',pending_review:'Checkout confirmation pending',awaiting_agreement:'Waiting for agreement',
    awaiting_payment:'Waiting for payment',payment_pending:'Payment sent',payment_review:'Payment under review',funded:'Funds secured — ready to ship',
    shipped:'Item shipped',inspection:'Buyer inspection',accepted:'Accepted — payout pending',return_requested:'Return requested',
    returned:'Return received',disputed:'Dispute in progress',paid:'Seller paid',refunded:'Buyer refunded',cancelled:'Cancelled',failed:'Checkout not started'};
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = (value,currency) => new Intl.NumberFormat('en-CA',{style:'currency',currency:currency === 'EURO' ? 'EUR' : currency,currencyDisplay:'code'}).format(Number(value));
  let app, dialog, opener, pending, busy = false, opening = 0;
  function safeUrl(value) {
    try {const url=new URL(value);return url.protocol==='https:' && ['www.escrow.com','www.escrow-sandbox.com'].includes(url.hostname) && ['/pay','/login-page'].includes(url.pathname) ? url.href : '';}
    catch {return '';}
  }
  function createDialog() {
    if (dialog) return dialog;
    const css=document.createElement('link');css.rel='stylesheet';css.href='/assets/escrow-checkout.css?v=20261014-escrow-1';document.head.append(css);
    dialog=document.createElement('dialog');dialog.id='escrow-checkout-dialog';dialog.className='escrow-dialog';dialog.setAttribute('aria-labelledby','escrow-dialog-title');
    dialog.innerHTML='<div class="escrow-sheet"><header class="escrow-header"><div><span class="escrow-eyebrow">6IXO · SECURE PAYMENTS</span><h2 id="escrow-dialog-title">Pay with escrow</h2></div><button type="button" class="escrow-close" aria-label="Close escrow">×</button></header><div id="escrow-dialog-body" aria-live="polite"></div></div>';
    document.body.append(dialog);
    dialog.querySelector('.escrow-close').onclick=close;
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('click',event=>{if(event.target===dialog)close();});
    return dialog;
  }
  function close() {if(busy)return;opening++;dialog?.close();opener?.focus?.();}
  function body(html) {createDialog().querySelector('#escrow-dialog-body').innerHTML=html;}
  function show(title) {
    opener=document.activeElement;createDialog();dialog.querySelector('#escrow-dialog-title').textContent=title;
    if(!dialog.open)dialog.showModal();
    body('<p class="escrow-message" role="status">Loading secure payment details…</p>');
  }
  function fail(error) {
    body(`<div class="escrow-notice"><strong>Checkout is unavailable</strong><p>${escape(error.message || 'Unable to load escrow. Please try again.')}</p></div><p class="escrow-small">Do not send money based on a screenshot. The seller should ship only after Escrow.com confirms the funds are secured.</p><button type="button" class="escrow-button escrow-secondary" data-escrow-history>My escrow deals</button>`);
    dialog.querySelector('[data-escrow-history]').onclick=()=>history(app);
  }
  function auth(instance,callback) {
    app=instance;
    return instance.requireSignedIn({reason:'use escrow payments',onAuthed:callback});
  }
  async function open(instance,item) {
    if(!auth(instance,()=>open(instance,item)))return;
    if(busy)return;
    show('Review your escrow purchase');const run=++opening;
    pending=null;
    try {
      const config=await instance.callSupabaseFunction('escrow-config',{});
      if(run!==opening)return;
      if(config.connected!==true || config.payoutReady!==true)throw new Error(config.message || 'Escrow payments are being set up.');
      const {quote}=await instance.callSupabaseFunction('create-escrow-transaction',{action:'quote',listingId:String(item.publicId || item.serverListingPublicId || item.id)});
      if(run!==opening)return;
      if(!quote || !Number.isFinite(quote.serviceFee) || !quote.quoteToken)throw new Error('A verified quote is unavailable.');
      pending={quote,requestId:crypto.randomUUID()};
      renderQuote();
    } catch(error) {if(run===opening)fail(error);}
  }
  function renderQuote() {
    const q=pending.quote;
    body(`${q.environment==='sandbox' ? '<p class="escrow-sandbox">Test checkout — sandbox funds only</p>' : ''}
      <div class="escrow-product"><span class="escrow-shield" aria-hidden="true">✓</span><div><strong>${escape(q.title)}</strong><p>Funds held by Escrow.com</p></div></div>
      <dl class="escrow-totals"><div><dt>Item price</dt><dd>${money(q.amount,q.currency)}</dd></div><div><dt>6ixo service fee <small>2% · minimum 20 · maximum 500 ${escape(q.currency)}</small></dt><dd>${money(q.serviceFee,q.currency)}</dd></div><div><dt>Escrow.com fees <small>Provider estimate</small></dt><dd>${money(q.providerFee,q.currency)}</dd></div><div class="escrow-total"><dt>Estimated total</dt><dd>${money(q.estimatedTotal,q.currency)}</dd></div></dl>
      <p class="escrow-small">The final amount and available payment methods are confirmed on Escrow.com. Shipping must be agreed with the seller before checkout; it is not added here. ${q.currency==='CAD' ? 'CAD funding uses a bank wire transfer.' : ''}</p>
      <ol class="escrow-steps"><li><strong>Agree and fund</strong><span>Both parties use their verified 6ixo email on Escrow.com. The seller ships only after funds are secured.</span></li><li><strong>Receive and inspect</strong><span>You have 3 calendar days after confirmed delivery to accept the item or reject it on Escrow.com.</span></li><li><strong>Release payment</strong><span>Escrow.com releases payment after acceptance or the inspection deadline, under its terms. Report a problem before the deadline.</span></li></ol>
      <label class="escrow-consent"><input type="checkbox" id="escrow-agreed"><span>I agree to the item price, the 6ixo service fee, and the 3-day inspection period. I understand that returns, cancellations and fee refunds follow the <a href="https://www.escrow.com/escrow-101/terms-of-use" target="_blank" rel="noopener">Escrow.com terms</a>.</span></label>
      <p id="escrow-checkout-error" class="escrow-error" role="alert"></p><button type="button" class="escrow-button" id="escrow-continue" disabled>Continue to Escrow.com</button><button type="button" class="escrow-text-button" data-escrow-history>View my escrow deals</button>`);
    const check=dialog.querySelector('#escrow-agreed'),button=dialog.querySelector('#escrow-continue');
    check.onchange=()=>{button.disabled=!check.checked || busy;};
    button.onclick=start;
    dialog.querySelector('[data-escrow-history]').onclick=()=>history(app);
  }
  async function start() {
    if(busy || !pending || !dialog.querySelector('#escrow-agreed')?.checked)return;
    busy=true;const button=dialog.querySelector('#escrow-continue');button.disabled=true;button.textContent='Starting secure checkout…';
    dialog.querySelector('.escrow-close').disabled=true;
    try {
      const result=await app.callSupabaseFunction('create-escrow-transaction',{action:'start',listingId:pending.quote.listingId,
        requestId:pending.requestId,quoteToken:pending.quote.quoteToken,agreed:true});
      const url=safeUrl(result.order?.checkoutUrl);
      if(!url)throw new Error('Checkout could not be confirmed. Check My escrow deals before retrying.');
      // A checkout link or a return URL never confirms funding or receipt.
      window.location.assign(url);
    } catch(error) {
      dialog.querySelector('#escrow-checkout-error').textContent=error.message;
      button.textContent='Check my escrow deals';button.onclick=()=>history(app);
    } finally {busy=false;button.disabled=false;dialog.querySelector('.escrow-close').disabled=false;}
  }
  function renderOrders(orders,notice='') {
    body(`${notice ? `<p class="escrow-notice">${escape(notice)}</p>` : ''}<p class="escrow-small">Pay, submit tracking, accept or reject an item, and manage returns on Escrow.com. Refresh here to verify the latest status. The 6ixo service fee is collected through the escrow transaction.</p><div class="escrow-orders">${orders.length ? orders.map(order=>{
      const link=safeUrl(['awaiting_agreement','awaiting_payment'].includes(order.status) && order.role==='buyer' && order.checkoutUrl ? order.checkoutUrl : order.providerUrl);
      return `<article class="escrow-order"><div class="escrow-order-head"><span class="escrow-role">${order.role==='seller' ? 'Your sale' : 'Your purchase'}</span><span class="escrow-state">${escape(labels[order.status] || 'Status needs verification')}</span></div><h3>${escape(order.title)}</h3><p>${money(order.amount,order.currency)} <span>· 6ixo fee ${money(order.serviceFee,order.currency)}</span></p><p class="escrow-small">${order.transactionId ? `Escrow.com transaction #${escape(order.transactionId)}` : 'Provider confirmation pending'}${order.verifiedAt ? ` · Verified ${escape(new Date(order.verifiedAt).toLocaleString())}` : ' · Refresh to verify the provider status'}</p><div class="escrow-order-actions">${link ? `<a class="escrow-button" href="${escape(link)}" target="_blank" rel="noopener">${link.includes('/pay?') ? 'Continue checkout' : 'Manage on Escrow.com'}</a>` : ''}<button type="button" class="escrow-button escrow-secondary" data-refresh-escrow="${escape(order.id)}">Refresh status</button></div><p class="escrow-order-error escrow-error" role="alert"></p></article>`;
    }).join('') : '<p class="escrow-message">You have no escrow purchases or sales yet.</p>'}</div>`);
    dialog.querySelectorAll('[data-refresh-escrow]').forEach(button=>{button.onclick=async()=>{
      button.disabled=true;button.textContent='Checking provider…';
      try {
        const result=await app.callSupabaseFunction('create-escrow-transaction',{action:'refresh',orderId:button.dataset.refreshEscrow});
        const index=orders.findIndex(order=>order.id===result.order.id);if(index>=0)orders[index]=result.order;
        renderOrders(orders);
      } catch(error) {button.closest('.escrow-order').querySelector('.escrow-order-error').textContent=error.message;button.disabled=false;button.textContent='Refresh status';}
    };});
  }
  async function history(instance,notice='') {
    if(!auth(instance,()=>history(instance,notice)))return;
    if(busy)return;
    show('My escrow deals');const run=++opening;
    try {const data=await instance.callSupabaseFunction('create-escrow-transaction',{action:'list'});if(run===opening)renderOrders(data.orders || [],notice);}
    catch(error) {if(run===opening)body(`<p class="escrow-error" role="alert">${escape(error.message)}</p>`);}
  }
  function attach(instance) {
    app=instance;
    const container=document.querySelector('.profile-privacy-actions');
    if(container && !document.getElementById('my-escrow-deals')) {
      const button=document.createElement('button');button.type='button';button.id='my-escrow-deals';button.textContent='My escrow deals';button.onclick=()=>history(instance);container.append(button);
    }
    const params=new URLSearchParams(window.location.search);
    if(params.has('escrow_return')) {
      const url=new URL(window.location.href);url.searchParams.delete('escrow_return');window.history.replaceState(window.history.state,'',url.href);
      history(instance,'You have returned from Escrow.com. Refresh your order to verify whether funds are secured.');
    }
  }
  window.SixoEscrow={open,history,attach,safeUrl};
})();
