const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = { console, window: {}, setTimeout, clearTimeout };
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('./app.js', 'utf8'), context);

const result = context.buildSchedule(12, 7 * 60, 'solids', 'home', 0, {});
const mealTitles = result.blocks.filter(block => block.tag === 'feed').map(block => block.title);

assert.strictEqual(mealTitles.filter(title => title.includes('Обед')).length, 1);
assert.strictEqual(mealTitles.filter(title => title.includes('Полдник')).length, 1);
console.log('ok - one-nap schedule does not duplicate lunch');
