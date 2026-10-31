const assert = require('node:assert/strict');
const {money,totals,tax,monthEntries,recentRent} = require('../web/core.js');
const entries = [
  {id:'1',date:'2026-10-13',kind:'income',amount:100001,taxRate:4},
  {id:'2',date:'2026-10-13',kind:'income',amount:200001,taxRate:6},
  {id:'3',date:'2026-10-15',kind:'expense',amount:70000,categoryId:'rent',createdAt:'2026-10-15T10:00:00Z'},
  {id:'4',date:'2026-09-01',kind:'expense',amount:40000,categoryId:'rent',createdAt:'2026-09-01T10:00:00Z'},
];
assert.equal(tax(entries[0]),4000);
assert.equal(tax(entries[1]),12000);
assert.deepEqual(totals(monthEntries(entries,2026,9)), {income:300002,expenses:70000,tax:16000,profit:214002});
assert.equal(recentRent(entries,'rent'),70000);
assert.ok(money(10000).includes('100'));
console.log('Core calculations: OK');
const stages = [
  {id:'pending',kind:'income',amount:80000,taxRate:4,status:'planned'},
  {id:'progress',kind:'expense',amount:30000,status:'in_progress'},
  {id:'finished',kind:'income',amount:120000,taxRate:4,status:'completed'},
  {id:'cancelled',kind:'expense',amount:4000,status:'cancelled'},
];
assert.deepEqual(totals(stages),{income:120000,expenses:0,tax:4800,profit:115200});
assert.deepEqual(totals([...stages,{id:'legacy',kind:'income',amount:60000,taxRate:0}]),{income:180000,expenses:0,tax:4800,profit:175200});
console.log('Deal status accounting: OK');
