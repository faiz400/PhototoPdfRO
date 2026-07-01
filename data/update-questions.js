// Run with: node data/update-questions.js
// Reads questions.csv → writes questions.json and ../mobile/www/questions.json
// CSV format: num,title,guideline  (no quotes needed unless value contains comma)

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'questions.csv');
const jsonPath = path.join(__dirname, 'questions.json');
const mobileJsonPath = path.join(__dirname, '..', 'mobile', 'www', 'questions.json');

const lines = fs.readFileSync(csvPath, 'utf8').split('\n').filter(Boolean);
const header = lines[0].split(',');

const questions = lines.slice(1).map(line => {
  // Split on first two commas only (guideline may contain commas)
  const firstComma = line.indexOf(',');
  const secondComma = line.indexOf(',', firstComma + 1);
  const num = parseInt(line.slice(0, firstComma), 10);
  const title = line.slice(firstComma + 1, secondComma).trim();
  const guideline = line.slice(secondComma + 1).trim();
  return { num, title, guideline };
}).filter(q => !isNaN(q.num));

const json = JSON.stringify(questions, null, 2);
fs.writeFileSync(jsonPath, json);
fs.writeFileSync(mobileJsonPath, json);

console.log(`Updated ${questions.length} questions → questions.json + mobile/www/questions.json`);
