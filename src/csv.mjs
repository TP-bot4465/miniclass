/**
 * Parse CSV/TSV content into rows (supports quoted fields, comma, semicolon, or tab delimiters).
 */
export function parseCsvRows(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const lines = [];
  let currentRow = [];
  let currentField = '';
  let inQuotes = false;

  // Detect delimiter from first non-empty line
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  let delimiter = ',';
  if (firstLine.includes('\t')) delimiter = '\t';
  else if (firstLine.split(';').length > firstLine.split(',').length) delimiter = ';';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentField.trim());
        lines.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        currentRow.push(currentField.trim());
        lines.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    lines.push(currentRow);
  }

  return lines.filter((r) => r.some((cell) => cell !== ''));
}

/**
 * Format 2D array as UTF-8 with BOM CSV (opens directly in Microsoft Excel with Vietnamese accents intact).
 */
export function toCsvBuffer(rows) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvBody = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
  // Prepend UTF-8 BOM (\uFEFF) for Excel compatibility
  return Buffer.from('\uFEFF' + csvBody, 'utf8');
}
