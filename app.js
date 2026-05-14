const defaults = {
  superReturn: 6,
  outsideReturn: 8,
  cpiRate: 2,
  superContribTax: 15,
  fhssReleaseTax: 9,
  bonusWithholding: 47,
  sgRate: 12,
  annualConcessionalCap: 30000,
  carryForwardCap: 15000,
  fhssAnnualCap: 15000,
  fhssTotalCap: 50000,
  saleYearIncome: 165000,
  hasHelp: true,
  applyNewCgt: true,
  years: [
    { fy: 'FY26', salary: 132000, bonus: 8000, contrib: 15000 },
    { fy: 'FY27', salary: 132000, bonus: 20000, contrib: 15000 },
    { fy: 'FY28', salary: 165000, bonus: 16000, contrib: 15000 },
    { fy: 'FY29', salary: 165000, bonus: 28000, contrib: 5000 }
  ]
};

let state = structuredClone(defaults);

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-AU');
const pct = (v) => Number(v || 0) / 100;

function taxYearLowRate(index) {
  // FY26 = 16%, FY27 = 15%, FY28+ = 14% under current legislated cuts used in the prior model.
  if (index === 0) return 0.16;
  if (index === 1) return 0.15;
  return 0.14;
}

function incomeTax(taxable, index) {
  taxable = Math.max(0, taxable);
  const brackets = [
    [0, 18200, 0],
    [18200, 45000, taxYearLowRate(index)],
    [45000, 135000, 0.30],
    [135000, 190000, 0.37],
    [190000, Infinity, 0.45]
  ];
  return brackets.reduce((sum, [lo, hi, rate]) => {
    if (taxable <= lo) return sum;
    return sum + (Math.min(taxable, hi) - lo) * rate;
  }, 0);
}

function helpRepayment(income) {
  if (!state.hasHelp) return 0;
  if (income <= 67000) return 0;
  if (income <= 125000) return 0.15 * (income - 67000);
  if (income < 179286) return 8700 + 0.17 * (income - 125000);
  return 0.10 * income;
}

function totalLiability(grossIncome, deduction, yearIndex, taxableCapitalGain = 0) {
  const taxable = Math.max(0, grossIncome - deduction + taxableCapitalGain);
  const medicare = 0.02 * taxable;
  const repaymentIncome = taxable + deduction; // reportable super added back
  return incomeTax(taxable, yearIndex) + medicare + helpRepayment(repaymentIncome);
}

function annualWithheld(year, index) {
  const regularWithheld = totalLiability(year.salary, 0, index);
  return regularWithheld + pct(state.bonusWithholding) * year.bonus;
}

function refundWithContribution(year, index, contribution) {
  const gross = year.salary + year.bonus;
  return annualWithheld(year, index) - totalLiability(gross, contribution, index);
}

function refundWithoutContribution(year, index) {
  const gross = year.salary + year.bonus;
  return annualWithheld(year, index) - totalLiability(gross, 0, index);
}

function monthlyRate(annualPct) {
  return Math.pow(1 + pct(annualPct), 1 / 12) - 1;
}

function grow(amount, startMonth, endMonth, rate) {
  return amount * Math.pow(1 + rate, endMonth - startMonth);
}

function cgtTaxableForParcel(cost, purchaseMonth, sellMonth, finalValue, outsideRate, cpiRate) {
  const policyMonth = 24; // 1 July 2027 if month 0 is July 2025
  if (!state.applyNewCgt) {
    return Math.max(0, finalValue - cost) * 0.50;
  }
  if (purchaseMonth < policyMonth && sellMonth > policyMonth) {
    const valueAtPolicy = grow(cost, purchaseMonth, policyMonth, outsideRate);
    const prePolicyGain = Math.max(0, valueAtPolicy - cost) * 0.50;
    const indexedPolicyCostBase = valueAtPolicy * Math.pow(1 + cpiRate, sellMonth - policyMonth);
    const postPolicyGain = Math.max(0, finalValue - indexedPolicyCostBase);
    return prePolicyGain + postPolicyGain;
  }
  const indexedCostBase = cost * Math.pow(1 + cpiRate, sellMonth - purchaseMonth);
  return Math.max(0, finalValue - indexedCostBase);
}

function finalTaxOnCapitalGain(taxableGain, saleYearIndex) {
  return totalLiability(state.saleYearIncome, 0, saleYearIndex, taxableGain) - totalLiability(state.saleYearIncome, 0, saleYearIndex, 0);
}

function outsideAfterTax(parcels, endMonth, saleYearIndex, outsideRate, cpiRate) {
  let grossValue = 0;
  let taxableGain = 0;
  for (const p of parcels) {
    const finalValue = grow(p.amount, p.month, endMonth, outsideRate);
    grossValue += finalValue;
    taxableGain += cgtTaxableForParcel(p.amount, p.month, endMonth, finalValue, outsideRate, cpiRate);
  }
  const finalTax = finalTaxOnCapitalGain(taxableGain, saleYearIndex);
  return { net: grossValue - finalTax, gross: grossValue, taxableGain, finalTax };
}

function superAfterTax(parcels, endMonth, superRate) {
  let gross = 0;
  for (const p of parcels) {
    gross += p.amount * (1 - pct(state.superContribTax)) * Math.pow(1 + superRate, endMonth - p.month);
  }
  const releaseTax = gross * pct(state.fhssReleaseTax);
  return { net: gross - releaseTax, gross, releaseTax };
}

function cappedContributions() {
  let remaining = state.fhssTotalCap;
  return state.years.map((y) => {
    const eligible = Math.min(y.contrib, state.fhssAnnualCap, Math.max(0, remaining));
    remaining -= eligible;
    return eligible;
  });
}

function runScenario(type) {
  const endMonth = state.years.length * 12 + 12; // one extra FY until buying/selling in FY after last input
  const saleYearIndex = state.years.length;
  const superRate = monthlyRate(state.superReturn);
  const outsideRate = monthlyRate(state.outsideReturn);
  const cpiRate = monthlyRate(state.cpiRate);
  const eligible = cappedContributions();
  const superParcels = [];
  const outsideParcels = [];

  state.years.forEach((year, i) => {
    const fyStart = i * 12;
    const fyEnd = (i + 1) * 12;
    const contribution = eligible[i];

    if (year.bonus > 0) {
      outsideParcels.push({ amount: year.bonus * (1 - pct(state.bonusWithholding)), month: fyEnd - 1 });
    }

    if (type === 1) {
      for (let m = 0; m < 12; m++) superParcels.push({ amount: contribution / 12, month: fyStart + m });
      const refund = refundWithContribution(year, i, contribution);
      if (refund > 0) outsideParcels.push({ amount: refund, month: fyEnd });
    }

    if (type === 2) {
      const temp = Array.from({ length: 12 }, (_, m) => ({ amount: contribution / 12, month: fyStart + m }));
      let proceeds = 0;
      let taxableGain = 0;
      for (const p of temp) {
        const finalValue = grow(p.amount, p.month, fyEnd, outsideRate);
        proceeds += finalValue;
        taxableGain += cgtTaxableForParcel(p.amount, p.month, fyEnd, finalValue, outsideRate, cpiRate);
      }
      const eofyCgt = totalLiability(year.salary + year.bonus, 0, i, taxableGain) - totalLiability(year.salary + year.bonus, 0, i, 0);
      const netProceeds = Math.max(0, proceeds - eofyCgt);
      const contributed = Math.min(contribution, netProceeds);
      const leftover = netProceeds - contributed;
      if (contributed > 0) superParcels.push({ amount: contributed, month: fyEnd });
      if (leftover > 0) outsideParcels.push({ amount: leftover, month: fyEnd });
      const refund = refundWithContribution(year, i, contributed);
      if (refund > 0) outsideParcels.push({ amount: refund, month: fyEnd });
    }

    if (type === 3) {
      for (let m = 0; m < 12; m++) outsideParcels.push({ amount: contribution / 12, month: fyStart + m });
      const refund = refundWithoutContribution(year, i);
      if (refund > 0) outsideParcels.push({ amount: refund, month: fyEnd });
    }
  });

  const s = superAfterTax(superParcels, endMonth, superRate);
  const o = outsideAfterTax(outsideParcels, endMonth, saleYearIndex, outsideRate, cpiRate);
  return { superNet: s.net, superGross: s.gross, releaseTax: s.releaseTax, outsideNet: o.net, outsideGross: o.gross, taxableGain: o.taxableGain, finalTax: o.finalTax, total: s.net + o.net };
}

function readInputs() {
  for (const key of ['superReturn','outsideReturn','cpiRate','superContribTax','fhssReleaseTax','bonusWithholding','sgRate','annualConcessionalCap','carryForwardCap','fhssAnnualCap','fhssTotalCap','saleYearIncome']) {
    state[key] = Number($(key).value || 0);
  }
  state.hasHelp = $('hasHelp').checked;
  state.applyNewCgt = $('applyNewCgt').checked;
}

function renderInputs() {
  for (const key of ['superReturn','outsideReturn','cpiRate','superContribTax','fhssReleaseTax','bonusWithholding','sgRate','annualConcessionalCap','carryForwardCap','fhssAnnualCap','fhssTotalCap','saleYearIncome']) {
    $(key).value = state[key];
  }
  $('hasHelp').checked = state.hasHelp;
  $('applyNewCgt').checked = state.applyNewCgt;
}

function renderYears() {
  const body = document.querySelector('#yearsTable tbody');
  body.innerHTML = '';
  const eligible = cappedContributions();
  let capNeed = 0;
  state.years.forEach((year, i) => {
    const sg = (year.salary + year.bonus) * pct(state.sgRate);
    const capUsed = sg + year.contrib;
    capNeed += Math.max(0, capUsed - state.annualConcessionalCap);
    const refund = refundWithContribution(year, i, eligible[i]);
    const noContribRefund = refundWithoutContribution(year, i);
    const extra = refund - noContribRefund;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input data-i="${i}" data-field="fy" value="${year.fy}"></td>
      <td><input type="number" data-i="${i}" data-field="salary" value="${year.salary}"></td>
      <td><input type="number" data-i="${i}" data-field="bonus" value="${year.bonus}"></td>
      <td><input type="number" data-i="${i}" data-field="contrib" value="${year.contrib}"></td>
      <td>$${fmt(sg)}</td>
      <td>$${fmt(capUsed)}</td>
      <td>${refund >= 0 ? '$' + fmt(refund) + ' refund' : '$' + fmt(-refund) + ' payable'}</td>
      <td>$${fmt(extra)}</td>
    `;
    body.appendChild(tr);
  });
  if (capNeed > state.carryForwardCap) {
    $('capWarning').textContent = `Estimated carry-forward cap needed is $${fmt(capNeed)}, which exceeds the entered available carry-forward cap by $${fmt(capNeed - state.carryForwardCap)}.`;
  } else {
    $('capWarning').textContent = `Estimated carry-forward cap needed is $${fmt(capNeed)}. Entered available carry-forward cap is $${fmt(state.carryForwardCap)}.`;
  }
  body.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.i);
      const field = e.target.dataset.field;
      state.years[i][field] = field === 'fy' ? e.target.value : Number(e.target.value || 0);
      calculateAndRender(false);
    });
  });
}

function renderResults() {
  const names = {
    1: 'Monthly super immediately',
    2: 'Invest monthly, then EOFY super',
    3: 'Outside only'
  };
  const results = [1, 2, 3].map((n) => ({ id: n, name: names[n], ...runScenario(n) }));
  const baseline = results.find((r) => r.id === 3).total;
  const best = results.reduce((a, b) => (b.total > a.total ? b : a), results[0]);

  $('bestScenario').textContent = best.name;
  $('bestScenarioDelta').textContent = `Total after-tax value: $${fmt(best.total)} (${best.total - baseline >= 0 ? '+' : '-'}$${fmt(Math.abs(best.total - baseline))} vs outside-only)`;

  const cards = $('scenarioCards');
  cards.innerHTML = '';
  results.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<h3>${r.name}</h3><div class="big">$${fmt(r.total)}</div><div class="small">${r.total - baseline >= 0 ? '+' : '-'}$${fmt(Math.abs(r.total - baseline))} vs outside-only</div>`;
    cards.appendChild(div);
  });

  const tbody = document.querySelector('#resultsTable tbody');
  tbody.innerHTML = '';
  results.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name}</td>
      <td>$${fmt(r.superNet)}</td>
      <td>$${fmt(r.outsideNet)}</td>
      <td><strong>$${fmt(r.total)}</strong></td>
      <td>${r.total - baseline >= 0 ? '+' : '-'}$${fmt(Math.abs(r.total - baseline))}</td>
      <td>$${fmt(r.taxableGain)}</td>
      <td>$${fmt(r.finalTax)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function calculateAndRender(read = true) {
  if (read) readInputs();
  renderYears();
  renderResults();
}

function addYear() {
  const last = state.years[state.years.length - 1];
  const lastNum = Number((last?.fy || 'FY29').replace(/\D/g, '')) || 29;
  state.years.push({ fy: `FY${lastNum + 1}`, salary: last?.salary || 165000, bonus: 0, contrib: 0 });
  calculateAndRender(false);
}

function removeYear() {
  if (state.years.length > 1) {
    state.years.pop();
    calculateAndRender(false);
  }
}

function attachGlobalListeners() {
  for (const key of ['superReturn','outsideReturn','cpiRate','superContribTax','fhssReleaseTax','bonusWithholding','sgRate','annualConcessionalCap','carryForwardCap','fhssAnnualCap','fhssTotalCap','saleYearIncome']) {
    $(key).addEventListener('input', () => calculateAndRender(true));
  }
  $('hasHelp').addEventListener('change', () => calculateAndRender(true));
  $('applyNewCgt').addEventListener('change', () => calculateAndRender(true));
  $('addYearBtn').addEventListener('click', addYear);
  $('removeYearBtn').addEventListener('click', removeYear);
  $('resetBtn').addEventListener('click', () => { state = structuredClone(defaults); renderInputs(); calculateAndRender(false); });
}

renderInputs();
attachGlobalListeners();
calculateAndRender(false);
