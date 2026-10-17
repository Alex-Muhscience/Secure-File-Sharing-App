function ratio(original, artifact) {
  if (![original, artifact].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid byte count');
  return { reduction: original ? (original - artifact) / original : null, targetMet: original ? artifact * 4 <= original : null };
}
function summarize(rows) {
  if (!rows.length || rows.some(row => row.verified !== true)) throw new Error('Only verified runs can be summarized');
  const output = { repetitions: rows.length };
  for (const key of Object.keys(rows[0]).filter(key => typeof rows[0][key] === 'number')) {
    const values = rows.map(row => row[key]).sort((a, b) => a - b);
    if (values.some(value => !Number.isFinite(value))) throw new Error('Incomplete measurements');
    const middle = Math.floor(values.length / 2);
    output[key] = { median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, min: values[0], max: values.at(-1) };
  }
  return output;
}
module.exports = { ratio, summarize };
