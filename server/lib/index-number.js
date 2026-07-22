/** UCC index: PS/CSC/24/0057 → FACULTY/PROGRAM/YEAR/SEQ */
const INDEX_PATTERN = /^[A-Z]{2}\/[A-Z]{3}\/\d{2}\/\d{4}$/;
const PROGRAM_CODES = new Set(['PHY', 'CSC', 'MTH', 'CHM', 'BIO', 'STA']);

function normalizeIndexNumber(indexNumber) {
  const chars = String(indexNumber || '')
    .trim()
    .toUpperCase()
    .replace(/\\+/g, '/')
    .replace(/[^A-Z0-9]/g, '');

  const parts = [
    chars.slice(0, 2),
    chars.slice(2, 5),
    chars.slice(5, 7),
    chars.slice(7, 11),
  ].filter(Boolean);

  return parts.join('/');
}

function isValidIndexNumber(indexNumber) {
  const value = normalizeIndexNumber(indexNumber);
  if (!INDEX_PATTERN.test(value)) return false;
  const program = value.split('/')[1];
  return PROGRAM_CODES.has(program);
}

function indexFormatError() {
  return 'Index must be PS/CSC/24/0057 (faculty/programme/year/number)';
}

module.exports = {
  INDEX_PATTERN,
  PROGRAM_CODES,
  normalizeIndexNumber,
  isValidIndexNumber,
  indexFormatError,
};
