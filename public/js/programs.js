/** UCC-style index: FACULTY/PROGRAM/YEAR/SEQ e.g. PS/CSC/22/009 */
const FACULTY_CODE = 'PS';

const PROGRAM_LIST = [
  { code: 'PHY', label: 'BSc Physics' },
  { code: 'CSC', label: 'BSc Computer Science' },
  { code: 'MTH', label: 'BSc Mathematics' },
  { code: 'CHM', label: 'BSc Chemistry' },
  { code: 'BIO', label: 'BSc Biology' },
  { code: 'STA', label: 'BSc Statistics' },
];

function normalizeIndexNumber(indexNumber) {
  return String(indexNumber || '')
    .trim()
    .toUpperCase()
    .replace(/\\+/g, '/')
    .replace(/\s+/g, '');
}

function programGroupFromIndex(indexNumber) {
  const parts = String(indexNumber || '').split('/').map((p) => p.trim());
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return 'Other';
}

function programLabelFromIndex(indexNumber) {
  const code = String(indexNumber || '').split('/')[1];
  const match = PROGRAM_LIST.find((p) => p.code === code);
  return match ? match.label : code || 'Unknown programme';
}

function programCodeFromIndex(indexNumber) {
  return String(indexNumber || '').split('/')[1] || '';
}
