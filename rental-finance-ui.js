/* Rental tax review and payout records. All permissions and totals are enforced by Supabase. */
(() => {
 const proto=DatingApp.prototype;
 const zones=['America/St_Johns','America/Halifax','America/Toronto','America/Winnipeg','America/Regina','America/Edmonton','America/Vancouver','America/Whitehorse','America/Iqaluit'];
 const rates={AB:5,BC:5,MB:5,NB:15,NL:15,NS:14,NT:5,NU:5,ON:13,PE:15,QC:5,SK:5,YT:5};
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=(value,currency)=>new Intl.NumberFormat('en-CA',{style:'currency',currency:currency||'CAD'}).format(Number(value||0)/100);
 const date=value=>value?new Date(value).toLocaleString():'Pending';
 const checked=value=>value?'checked':'';
 function taxRow(rule={},i=0){return `<fieldset data-tax-row class="rental-tax-row"><legend>Tax ${i+1}</legend>
 <label>Name<input data-tax="label" value="${esc(rule.label||['Provincial accommodation tax','Municipal accommodation tax','GST/HST'][i]||'Tax')}"></label>
 <label>Rate<input data-tax="rate" type="number" min="0" max="100" step="0.0001" value="${esc(rule.rate??0)}"></label>
 <label>Calculation<select data-tax="kind"><option value="percent">Percentage</option><option value="per_night" ${rule.kind==='per_night'?'selected':''}>Amount per night</option></select></label>
 <label>Who remits it<select data-tax="recipient"><option value="platform">6ixo</option><option value="host" ${rule.recipient==='host'?'selected':''}>Host</option></select></label>
 <div class="rental-tax-basis"><span>Apply percentage to:</span>${[['accommodation','Nightly charges'],['cleaning','Cleaning fee'],['service','6ixo service fee']].map(([key,label])=>`<label><input type="checkbox" data-tax="${key}" ${checked(rule[key]??key==='accommodation')}> ${label}</label>`).join('')}<label><input type="checkbox" data-tax="includePriorTaxes" ${checked(rule.includePriorTaxes)}> Include earlier taxes in the percentage basis</label><label><input type="checkbox" data-tax="exemptCalendarMonth" ${checked(rule.exemptCalendarMonth)}> Exempt stays of one calendar month or longer</label></div></fieldset>`;}
 function configCard(listing){const f=listing.finance||{}, rules=f.tax_rules||[],count=Math.max(3,rules.length);return `<details class="rental-finance-card"><summary>${esc(listing.title)} · ${esc(listing.city)} · ${f.reviewed_at?'Configured':'Setup required'}</summary>
 <form data-rental-finance-form="${esc(listing.id)}"><p>Review taxes for this property, including accommodation taxes. Rates below are added to the guest total. Existing bookings retain their original terms.</p>
 <div class="rental-finance-grid"><label>Property time zone<select name="zone" required><option value="">Choose the property’s time zone</option>${[...new Set([...zones,...(f.time_zone?[f.time_zone]:[])])].map(z=>`<option ${z===f.time_zone?'selected':''}>${esc(z)}</option>`).join('')}</select></label>
 <label>Check-in time<input name="checkin" type="time" required value="${esc(f.checkin_time||'15:00')}"></label>
 <label>Canadian province/territory<select data-province><option value="">Use a GST/HST rate as a starting point</option>${Object.entries(rates).map(([p,r])=>`<option value="${p}">${p} — ${r}% GST/HST</option>`).join('')}</select></label></div>
 ${Array.from({length:count},(_,i)=>taxRow(rules[i],i)).join('')}
 <label>Tax review notes<textarea name="notes" minlength="10" required placeholder="Record the province, city, applicable taxes, registration review, and who remits each tax.">${esc(f.review_notes||'')}</textarea></label>
 <label class="rental-tax-basis"><input name="reviewed" type="checkbox" required> I reviewed the applicable taxes and remittance responsibilities for this property.</label>
 <p>Full guest refunds until 24 hours before check-in. Host funds become eligible for release 24 hours after check-in. Times use the property’s time zone.</p>
 <button type="submit" class="btn-primary">Save property setup</button><p data-save-status role="status"></p></form></details>`;}
 function payoutRows(rows){return rows.length?rows.map(f=>`<article class="rental-finance-card"><strong>${esc(f.booking_public_id)}</strong><p>${money(f.host_amount_cents,f.currency)} host funds · ${esc(({pending:'Awaiting release',transferred:'Released to host Stripe account',held:'On hold',reversed:'Transfer reversed',cancelled:'Cancelled'})[f.payout_status]||f.payout_status)}</p><p>Eligible ${esc(date(f.payout_due_at))}</p><p>Guest taxes ${money(f.tax_cents,f.currency)} · 6ixo fee ${money(f.service_fee_cents,f.currency)}</p>${f.last_error?`<p role="status">${esc(f.last_error)}</p>`:''}</article>`).join(''):'<p>No rental payout records yet.</p>';}
 const admin=proto.renderAdminDashboard;
 proto.renderAdminDashboard=async function(...args){
  if(document.activeElement?.closest('[data-rental-finance-form]'))return;
  await admin.apply(this,args);
  if(!this.isHostAdmin()||!this.supabase)return;
  const list=document.getElementById('admin-moderation-list');if(!list)return;
  const section=document.createElement('section');section.className='admin-application-section rental-finance-panel';section.innerHTML='<h4>Rental taxes and payouts</h4><p>Loading property setup…</p>';list.append(section);
  try {
   const {data,error}=await this.supabase.rpc('get_rental_finance_admin');if(error)throw error;
   section.innerHTML=`<h4>Rental taxes and payouts</h4><p>${Number(data.pendingEmails||0)} application emails awaiting automatic delivery.</p>${(data.listings||[]).map(configCard).join('')||'<p>Published stay listings will appear here for tax and local check-in setup.</p>'}<h4>Payout records</h4>${payoutRows(data.payouts||[])}`;
   section.addEventListener('change',event=>{
    if(!event.target.matches('[data-province]')||!event.target.value)return;
    const row=Array.from(event.target.closest('form').querySelectorAll('[data-tax-row]')).at(-1),rate=rates[event.target.value];
    row.querySelector('[data-tax="label"]').value=rate>5?'HST':'GST';row.querySelector('[data-tax="rate"]').value=rate;
    for(const key of ['accommodation','cleaning','service'])row.querySelector(`[data-tax="${key}"]`).checked=true;
   });
   section.addEventListener('submit',async event=>{
    const form=event.target.closest('[data-rental-finance-form]');if(!form)return;event.preventDefault();if(!form.reportValidity())return;
    const button=form.querySelector('button[type=submit]'),status=form.querySelector('[data-save-status]');button.disabled=true;
    try{
     const rules=Array.from(form.querySelectorAll('[data-tax-row]')).map(row=>Object.fromEntries(Array.from(row.querySelectorAll('[data-tax]')).map(input=>[input.dataset.tax,input.type==='checkbox'?input.checked:input.dataset.tax==='rate'?Number(input.value):input.value]))).filter(r=>r.rate>0);
     const {error}=await this.supabase.rpc('configure_rental_listing_finance',{p_listing_id:form.dataset.rentalFinanceForm,p_time_zone:form.elements.zone.value,p_checkin_time:form.elements.checkin.value,p_tax_rules:rules,p_review_notes:form.elements.notes.value});if(error)throw error;
     status.textContent='Saved. New bookings will use these tax and payout terms.';
     form.closest('details').querySelector('summary').textContent=form.closest('details').querySelector('summary').textContent.replace('Setup required','Configured');
    }catch(error){status.textContent=error.message||'Unable to save property setup.';}finally{button.disabled=false;}
   });
  }catch(error){section.innerHTML=`<h4>Rental taxes and payouts</h4><p role="status">${esc(error.message||'Unable to load financial setup.')}</p>`;}
 };
 const loadHost=proto.loadHostRentalListings;
 proto.loadHostRentalListings=async function(...args){
  const result=await loadHost.apply(this,args);
  document.getElementById('host-rental-settlement')?.remove();
  if(!this.canViewHostBookings()||!this.supabase||!this.currentUser?.id)return result;
  const target=document.getElementById('host-rental-listings-section');if(!target)return result;
  const section=document.createElement('section');section.id='host-rental-settlement';section.className='host-bookings-section rental-finance-panel';target.after(section);
  try {
   const {data,error}=await this.supabase.from('rental_booking_finance').select('*').eq('host_user_id',this.currentUser.id).order('created_at',{ascending:false}).limit(50);if(error)throw error;
   const {data:bank,error:bankError}=await this.supabase.from('rental_bank_payouts').select('*').order('updated_at',{ascending:false}).limit(20);if(bankError)throw bankError;
   section.innerHTML=`<h4>Your stay payouts</h4><p>Funds are released to your Stripe account 24 hours after check-in. Your Stripe dashboard shows when your bank receives them.</p>${payoutRows(data||[])}<h4>Bank payouts</h4>${(bank||[]).map(p=>`<p>${money(p.amount_cents,p.currency)} · ${esc(p.status)} · Expected ${esc(date(p.arrival_date))}${p.failure_message?` · ${esc(p.failure_message)}`:''}</p>`).join('')||'<p>No bank payout updates yet.</p>'}`;
  }catch(error){section.innerHTML=`<h4>Your stay payouts</h4><p role="status">${esc(error.message||'Unable to load payouts.')}</p>`;}
  return result;
 };
})();
