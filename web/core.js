/* Shared pure calculations, usable in the browser and Node tests. All amounts are integer kopecks. */
(function (root) {
  'use strict';
  const money = cents => new Intl.NumberFormat('ru-RU', {style:'currency', currency:'RUB', maximumFractionDigits: Number(cents) % 100 === 0 ? 0 : 2}).format((Number(cents) || 0) / 100);
  const tax = entry => entry.kind === 'income' ? Math.round(entry.amount * Number(entry.taxRate || 0) / 100) : 0;
  function totals(entries) {
    return entries.reduce((result, e) => {
      if (e.status && e.status !== 'completed') return result;
      if (e.kind === 'income') { result.income += e.amount; result.tax += tax(e); }
      else result.expenses += e.amount;
      result.profit = result.income - result.expenses - result.tax;
      return result;
    }, {income: 0, expenses: 0, tax: 0, profit: 0});
  }
  function monthEntries(entries, year, month) {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
    return entries.filter(e => e.date.startsWith(prefix));
  }
  function recentRent(entries, rentCategoryId) {
    return entries.filter(e => e.kind === 'expense' && e.categoryId === rentCategoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.amount ?? null;
  }
  const api = {money, tax, totals, monthEntries, recentRent};
  root.NailsCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
