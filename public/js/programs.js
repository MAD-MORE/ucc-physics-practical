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

function buildIndexNumber(programCode, seq) {
  return `${FACULTY_CODE}/${programCode}/22/${String(seq).padStart(3, '0')}`;
}

/** Must match scripts/seed.js student generation. */
function seededStudentBySeq(seq) {
  const n = Number(seq);
  if (n === 1) {
    return {
      full_name: 'Ama Mensah',
      index_number: buildIndexNumber('PHY', 1),
      phone_number: '0244000001',
      email: 'ama.mensah@test.ucc.edu.gh',
      program_group: `${FACULTY_CODE}/PHY`,
      program: 'BSc Physics',
    };
  }
  if (n === 101) {
    return {
      full_name: 'No Payment Student',
      index_number: buildIndexNumber('PHY', 101),
      phone_number: '0244000101',
      email: 'nopayment.101@test.ucc.edu.gh',
      program_group: `${FACULTY_CODE}/PHY`,
      program: 'BSc Physics',
    };
  }
  const prog = PROGRAM_LIST[(n - 2) % PROGRAM_LIST.length];
  const padded = String(n).padStart(3, '0');
  return {
    full_name: `${prog.code} Student ${padded}`,
    index_number: buildIndexNumber(prog.code, n),
    phone_number: `0244${String(n).padStart(6, '0')}`,
    email: `${prog.code.toLowerCase()}.${padded}@test.ucc.edu.gh`,
    program_group: `${FACULTY_CODE}/${prog.code}`,
    program: prog.label,
  };
}

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
